# Targeted second pass: bare `agentos` → `palmyr`.
# This is the CLI command name in user-visible docs/help text.
# SKIP files where `agentos` is a stable identifier (DB filenames, schema check
# constraints, ignore patterns).
#
# Word boundary used: replace `agentos` only when not adjacent to other word chars.
# (Excludes `agntos.dev`-style strings that would have been caught by sweep 1.)

$ErrorActionPreference = "Stop"

# Files where `agentos` is NOT just a brand name and must NOT be rewritten.
$skipExact = @(
    'src/db.ts',                  # DB filename + CHECK constraint enum value
    '.gitignore',                 # data/agentos.db ignore patterns
    'cli/package-lock.json',
    'package-lock.json',
    'frontend/discovery/package-lock.json',
    'scripts/rebrand-sweep.ps1',
    'scripts/rebrand-sweep-2.ps1'
)

# Skip directory rename targets — handled separately
$skipPrefix = @(
    'skills/agentos/'
)

$binarySkip = '\.(png|jpg|jpeg|gif|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip)$'

$files = git ls-files | Where-Object {
    $f = $_
    if ($f -match $binarySkip) { return $false }
    if ($skipExact -contains $f) { return $false }
    foreach ($p in $skipPrefix) { if ($f.StartsWith($p)) { return $false } }
    return $true
}

# Word-boundary regex: `agentos` not preceded/followed by word chars
$pattern = '\bagentos\b'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$changed = 0

foreach ($f in $files) {
    if (-not (Test-Path $f)) { continue }
    $content = [System.IO.File]::ReadAllText($f)
    $orig = $content
    $content = [regex]::Replace($content, $pattern, 'palmyr')
    if ($content -ne $orig) {
        [System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
        $changed++
        Write-Host "updated: $f"
    }
}

Write-Host ""
Write-Host "$changed files updated"
