/**
 * Tests for phone number transfer / share / unshare.
 *
 * Covers:
 *  - shareNumber appends idempotently, unshareNumber removes
 *  - transferNumber flips owner and clears sharedWith
 *  - hasNumberAccess for owner / shared wallet / stranger
 *  - getPhoneNumbersByWallet returns owned + shared rows only
 *  - getMessages allows shared wallets and rejects strangers (403)
 *  - shared_with survives a setPhoneNumber round-trip (release path)
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db, initDatabase } from "../db";
import { storage } from "../services/storage";
import * as phoneService from "../services/phone";
import { PhoneNumber } from "../types";

const OWNER = "WALLEToooooooooooooooooooooooooooooooooooo";
const FRIEND = "WALLETffffffffffffffffffffffffffffffffffff";
const STRANGER = "WALLETssssssssssssssssssssssssssssssssssss";

function insertNumber(id: string, owner: string, sharedWith: string[] = []): PhoneNumber {
  const record: PhoneNumber = {
    id,
    phoneNumber: `+1555000${id.slice(-4).padStart(4, "0")}`,
    country: "US",
    owner,
    provisionedAt: new Date().toISOString(),
    active: true,
    sharedWith,
  };
  storage.setPhoneNumber(id, record);
  return record;
}

before(() => {
  initDatabase();
});

beforeEach(() => {
  // FK-dependency order: sms_messages references phone_numbers.
  db.exec("DELETE FROM sms_messages; DELETE FROM phone_numbers;");
});

describe("shareNumber / unshareNumber", () => {
  it("appends a wallet and is idempotent", () => {
    insertNumber("pn-share-1", OWNER);
    assert.deepEqual(phoneService.shareNumber("pn-share-1", FRIEND), [FRIEND]);
    assert.deepEqual(phoneService.shareNumber("pn-share-1", FRIEND), [FRIEND]);
    assert.deepEqual(storage.getPhoneNumber("pn-share-1")?.sharedWith, [FRIEND]);
  });

  it("unshare removes only the targeted wallet", () => {
    insertNumber("pn-share-2", OWNER, [FRIEND, STRANGER]);
    assert.deepEqual(phoneService.unshareNumber("pn-share-2", FRIEND), [STRANGER]);
    assert.deepEqual(storage.getPhoneNumber("pn-share-2")?.sharedWith, [STRANGER]);
  });
});

describe("transferNumber", () => {
  it("flips owner and clears sharedWith", () => {
    insertNumber("pn-xfer-1", OWNER, [FRIEND]);
    phoneService.transferNumber("pn-xfer-1", STRANGER);
    const after = storage.getPhoneNumber("pn-xfer-1");
    assert.equal(after?.owner, STRANGER);
    assert.deepEqual(after?.sharedWith, []);
  });
});

describe("hasNumberAccess", () => {
  it("owner and shared wallets have access; strangers do not", () => {
    const number = insertNumber("pn-acc-1", OWNER, [FRIEND]);
    assert.equal(phoneService.hasNumberAccess(number, OWNER), true);
    assert.equal(phoneService.hasNumberAccess(number, FRIEND), true);
    assert.equal(phoneService.hasNumberAccess(number, STRANGER), false);
  });
});

describe("getPhoneNumbersByWallet", () => {
  it("returns owned and shared rows, nothing else", () => {
    insertNumber("pn-list-1", OWNER);
    insertNumber("pn-list-2", STRANGER, [OWNER]);
    insertNumber("pn-list-3", STRANGER);
    const ids = storage.getPhoneNumbersByWallet(OWNER).map(n => n.id).sort();
    assert.deepEqual(ids, ["pn-list-1", "pn-list-2"]);
  });

  it("does not match a wallet that is only a substring of another", () => {
    // The SQL LIKE pre-filter is a substring match; the JS refinement must
    // reject a shared_with entry that merely contains the caller's address.
    insertNumber("pn-list-4", STRANGER, [OWNER + "x"]);
    assert.deepEqual(storage.getPhoneNumbersByWallet(OWNER), []);
  });
});

describe("getMessages access scope", () => {
  it("allows the shared wallet and rejects strangers with 403", () => {
    insertNumber("pn-msg-1", OWNER, [FRIEND]);
    storage.pushSmsMessage("pn-msg-1", {
      id: "msg-1",
      phoneNumberId: "pn-msg-1",
      direction: "inbound",
      from: "+15550001111",
      to: "+15550002222",
      body: "hi",
      timestamp: new Date().toISOString(),
    });
    assert.equal(phoneService.getMessages("pn-msg-1", OWNER).length, 1);
    assert.equal(phoneService.getMessages("pn-msg-1", FRIEND).length, 1);
    assert.throws(() => phoneService.getMessages("pn-msg-1", STRANGER), (err: any) => err.statusCode === 403);
  });
});

describe("shared_with persistence", () => {
  it("survives a setPhoneNumber round-trip (release marks inactive)", () => {
    insertNumber("pn-rt-1", OWNER, [FRIEND]);
    const number = storage.getPhoneNumber("pn-rt-1")!;
    number.active = false;
    storage.setPhoneNumber("pn-rt-1", number);
    const after = storage.getPhoneNumber("pn-rt-1");
    assert.equal(after?.active, false);
    assert.deepEqual(after?.sharedWith, [FRIEND]);
  });
});
