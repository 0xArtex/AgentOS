/**
 * Async X account transfers. Playwright password-rotation takes 30-90s,
 * which exceeds Cloudflare's tunnel response timeout — every transfer would
 * otherwise return 502 to the client even when the work completed. This
 * service decouples the slow rotation from the HTTP request:
 *
 *   1. Caller hits POST /…/transfer → server inserts a row in `transfers`
 *      with status='pending', kicks off `runTransfer` via setImmediate,
 *      and responds 202 with { transfer_id, status }.
 *   2. Background runner decrypts creds, drives the changePassword UI,
 *      persists new creds + flips ownership atomically.
 *   3. CLI polls GET /transfers/:id until status='completed' or 'failed'.
 *
 * Crash recovery: in-process workers don't survive restart. On module
 * import `recoverStuckTransfers` flips any pending/rotating rows older
 * than 5 minutes to failed with reason 'server_restarted', so the caller
 * sees a definite outcome and can retry rather than polling forever.
 */
import { randomUUID } from "crypto";
import { db } from "../db";
import { xAccountService } from "./xaccounts";
import {
  getOwnerDecryptedState,
  persistRotatedCreds,
} from "./registered-accounts";
import { changePassword, generateStrongPassword } from "./social-operations";

export type AccountKind = "x_accounts" | "registered";
export type TransferStatus = "pending" | "rotating" | "completed" | "failed";
/**
 * What the background worker should do:
 *   - 'transfer'        rotate password + flip ownership to to_wallet (atomic).
 *   - 'unshare_rotate'  rotate password in place; ownership stays with from_wallet.
 *                       Used after a `palmyr twitter unshare --rotate` so the
 *                       revoked wallet's exported cookies stop working without
 *                       the owner losing access.
 */
export type TransferOp = "transfer" | "unshare_rotate";

export interface TransferRow {
  id: string;
  account_id: string;
  account_kind: AccountKind;
  from_wallet: string;
  to_wallet: string;
  op: TransferOp;
  status: TransferStatus;
  error: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Insert the transfer row and kick off the background rotation. Returns
 * immediately so the HTTP handler can respond 202 within Cloudflare's
 * response budget.
 *
 * For op='unshare_rotate', toWallet should equal fromWallet (rotation in
 * place, no ownership change).
 */
export function createTransfer(
  kind: AccountKind,
  accountId: string,
  fromWallet: string,
  toWallet: string,
  op: TransferOp = "transfer"
): TransferRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO transfers (id, account_id, account_kind, from_wallet, to_wallet, op, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).run(id, accountId, kind, fromWallet, toWallet, op);

  // Schedule the slow path. Errors thrown out of the runner shouldn't crash
  // the process — they get caught and persisted to the row so the poller
  // sees a definite failure rather than a perpetual "rotating".
  setImmediate(() => {
    runTransfer(id).catch((e) => {
      try {
        db.prepare(
          `UPDATE transfers SET status='failed', error=?, error_code='runner_exception', completed_at=? WHERE id=?`
        ).run(String(e?.message || e), new Date().toISOString(), id);
      } catch {
        /* worst case: row stays as 'rotating' until recoverStuckTransfers sweeps it */
      }
    });
  });

  return getTransfer(id)!;
}

export function getTransfer(id: string): TransferRow | null {
  const row = db
    .prepare(`SELECT * FROM transfers WHERE id = ?`)
    .get(id) as TransferRow | undefined;
  return row || null;
}

async function runTransfer(transferId: string): Promise<void> {
  const transfer = getTransfer(transferId);
  if (!transfer) throw new Error(`Transfer ${transferId} not found`);
  // Idempotent — if another scheduler already picked this up (or the row
  // was recovered as failed by the startup sweep), don't double-run.
  if (transfer.status !== "pending") return;

  db.prepare(`UPDATE transfers SET status='rotating', started_at=? WHERE id=?`).run(
    new Date().toISOString(),
    transferId
  );

  if (transfer.op === "unshare_rotate") {
    if (transfer.account_kind === "x_accounts") {
      await runPoolUnshareRotate(transfer);
    } else {
      await runRegisteredUnshareRotate(transfer);
    }
  } else if (transfer.account_kind === "x_accounts") {
    await runPoolTransfer(transfer);
  } else {
    await runRegisteredTransfer(transfer);
  }
}

async function runPoolTransfer(t: TransferRow): Promise<void> {
  const account = await xAccountService.getAccount(t.account_id);
  if (!account || account.sold_to !== t.from_wallet) {
    markFailed(
      t.id,
      "ownership_check_failed",
      "Account no longer owned by from_wallet"
    );
    return;
  }
  let cookies: any[] = [];
  try {
    cookies = JSON.parse(account.cookies || "[]");
  } catch {
    cookies = [];
  }
  if (cookies.length === 0) {
    markFailed(
      t.id,
      "no_cookies",
      "Account has no cached cookies — run twitter login first so the rotation has a session to drive"
    );
    return;
  }

  const newPassword = generateStrongPassword();
  const rotation = await changePassword({
    account_id: account.id,
    cookies,
    current_password: account.password,
    new_password: newPassword,
    log_out_other_sessions: true,
  });

  if (!rotation.success) {
    markFailed(
      t.id,
      rotation.error_code || "rotation_failed",
      rotation.error || "Password rotation failed"
    );
    return;
  }

  const newCookies =
    rotation.data?.cookies && rotation.data.cookies.length > 0
      ? JSON.stringify(rotation.data.cookies)
      : "[]";
  const updated = await xAccountService.transferOwnership(
    account.id,
    t.from_wallet,
    t.to_wallet,
    {
      password: newPassword,
      cookies: newCookies,
      auth_token: rotation.data?.auth_token || null,
    }
  );

  if (!updated) {
    // Edge: concurrent transfer slipped between the ownership check and the
    // DB update. The X-side password is already rotated. Whoever owns the
    // row now holds the new password — we just bail.
    markFailed(
      t.id,
      "concurrent_transfer",
      "Account ownership changed during rotation; password was rotated but transfer aborted"
    );
    return;
  }
  markCompleted(t.id);
}

async function runRegisteredTransfer(t: TransferRow): Promise<void> {
  const state = getOwnerDecryptedState(t.account_id, t.from_wallet);
  if (!state) {
    markFailed(
      t.id,
      "ownership_check_failed",
      "Registered account not found or not owned by from_wallet"
    );
    return;
  }
  if (state.cookies.length === 0) {
    markFailed(
      t.id,
      "no_cookies",
      "No cached cookies — re-register or run twitter login first"
    );
    return;
  }

  const newPassword = generateStrongPassword();
  const rotation = await changePassword({
    account_id: state.row.id,
    proxy_session_id: state.row.proxy_session_id,
    cookies: state.cookies,
    current_password: state.creds.password,
    new_password: newPassword,
    log_out_other_sessions: true,
  });

  if (!rotation.success) {
    markFailed(
      t.id,
      rotation.error_code || "rotation_failed",
      rotation.error || "Password rotation failed"
    );
    return;
  }

  const newCookies =
    rotation.data?.cookies && rotation.data.cookies.length > 0
      ? rotation.data.cookies
      : state.cookies;
  const newCreds = {
    ...state.creds,
    password: newPassword,
    auth_token: rotation.data?.auth_token || undefined,
    ct0: rotation.data?.ct0 || undefined,
  };

  const updated = persistRotatedCreds(
    state.row.id,
    t.from_wallet,
    newCreds,
    newCookies,
    { transferToWallet: t.to_wallet }
  );
  if (!updated) {
    markFailed(
      t.id,
      "concurrent_transfer",
      "Ownership changed during rotation; password was rotated but transfer aborted"
    );
    return;
  }
  markCompleted(t.id);
}

/**
 * Rotate the password on a pool account without flipping ownership.
 * Used by `palmyr twitter unshare --rotate` so the revoked share-holder's
 * cached cookies stop working immediately; the original owner keeps the
 * account with fresh credentials.
 */
async function runPoolUnshareRotate(t: TransferRow): Promise<void> {
  const account = await xAccountService.getAccount(t.account_id);
  if (!account || account.sold_to !== t.from_wallet) {
    markFailed(t.id, "ownership_check_failed", "Account no longer owned by from_wallet");
    return;
  }
  let cookies: any[] = [];
  try {
    cookies = JSON.parse(account.cookies || "[]");
  } catch {
    cookies = [];
  }
  if (cookies.length === 0) {
    markFailed(t.id, "no_cookies", "No cached cookies — run twitter login first");
    return;
  }

  const newPassword = generateStrongPassword();
  const rotation = await changePassword({
    account_id: account.id,
    cookies,
    current_password: account.password,
    new_password: newPassword,
    log_out_other_sessions: true,
  });

  if (!rotation.success) {
    markFailed(t.id, rotation.error_code || "rotation_failed", rotation.error || "Password rotation failed");
    return;
  }

  const newCookies =
    rotation.data?.cookies && rotation.data.cookies.length > 0
      ? JSON.stringify(rotation.data.cookies)
      : "[]";
  await xAccountService.updateCredentials(account.id, {
    password: newPassword,
    cookies: newCookies,
    auth_token: rotation.data?.auth_token || null,
  });
  markCompleted(t.id);
}

/**
 * Rotate the password on a BYO-registered account without flipping ownership.
 */
async function runRegisteredUnshareRotate(t: TransferRow): Promise<void> {
  const state = getOwnerDecryptedState(t.account_id, t.from_wallet);
  if (!state) {
    markFailed(t.id, "ownership_check_failed", "Registered account not found or not owned by from_wallet");
    return;
  }
  if (state.cookies.length === 0) {
    markFailed(t.id, "no_cookies", "No cached cookies — re-register or run twitter login first");
    return;
  }

  const newPassword = generateStrongPassword();
  const rotation = await changePassword({
    account_id: state.row.id,
    proxy_session_id: state.row.proxy_session_id,
    cookies: state.cookies,
    current_password: state.creds.password,
    new_password: newPassword,
    log_out_other_sessions: true,
  });

  if (!rotation.success) {
    markFailed(t.id, rotation.error_code || "rotation_failed", rotation.error || "Password rotation failed");
    return;
  }

  const newCookies =
    rotation.data?.cookies && rotation.data.cookies.length > 0
      ? rotation.data.cookies
      : state.cookies;
  const newCreds = {
    ...state.creds,
    password: newPassword,
    auth_token: rotation.data?.auth_token || undefined,
    ct0: rotation.data?.ct0 || undefined,
  };
  // No transferToWallet → ownership stays with from_wallet.
  persistRotatedCreds(state.row.id, t.from_wallet, newCreds, newCookies);
  markCompleted(t.id);
}

function markFailed(id: string, code: string, message: string): void {
  db.prepare(
    `UPDATE transfers SET status='failed', error=?, error_code=?, completed_at=? WHERE id=?`
  ).run(message, code, new Date().toISOString(), id);
}

function markCompleted(id: string): void {
  db.prepare(
    `UPDATE transfers SET status='completed', completed_at=? WHERE id=?`
  ).run(new Date().toISOString(), id);
}

/**
 * On startup, mark any pending/rotating rows older than 5 minutes as
 * failed with reason 'server_restarted'. We can't safely resume in-place:
 * the X-side password may or may not have been rotated, and replaying the
 * rotation with stale creds would just fail. The caller's retry path is
 * cleaner — pay the small fee again, get a fresh transfer.
 */
export function recoverStuckTransfers(): void {
  const stuckAgeMs = 5 * 60 * 1000;
  const cutoff = new Date(Date.now() - stuckAgeMs).toISOString();
  const result = db
    .prepare(
      `UPDATE transfers
       SET status='failed',
           error='Server restarted while transfer was in progress; check whether the password rotated on X (some did) and retry if needed',
           error_code='server_restarted',
           completed_at=datetime('now', 'utc')
       WHERE status IN ('pending', 'rotating') AND created_at < ?`
    )
    .run(cutoff);
  if (result.changes > 0) {
    console.log(
      `[transfers] Recovered ${result.changes} stuck transfer(s) on startup`
    );
  }
}

// Run on module import (server startup) so any rows left dangling by the
// previous process don't poison the polling UX.
recoverStuckTransfers();
