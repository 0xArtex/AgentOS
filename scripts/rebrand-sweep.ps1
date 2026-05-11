# One-time rebrand sweep: AgentOS → Palmyr, agntos.dev → palmyr.ai, etc.
# Operates only on files tracked by git (skips node_modules, .git, dist, etc.).
# Writes UTF-8 without BOM to avoid the PS 5.1 BOM-on-Set-Content gotcha.

$ErrorActionPreference = "Stop"

# Order matters: more specific replacements before broader ones.
$replacements = @(
    @{ Find = '@agntos/agentos'; Replace = '@palmyr/cli' },
    @{ Find = 'agntos.dev';      Replace = 'palmyr.ai' },
    @{ Find = '@agntoss';        Replace = '@Palmyr_ai' },
    @{ Find = 'agntoss';         Replace = 'Palmyr_ai' },
    @{ Find = 'AGENTOS_';        Replace = 'PALMYR_' },
    @{ Find = 'AgentOS';         Replace = 'Palmyr' },
    @{ Find = '.agentos';        Replace = '.palmyr' }
)

# Binary-ish extensions to skip entirely.
$binarySkip = '\.(png|jpg|jpeg|gif|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip)$'

# Tracked files only.
$files = git ls-files | Where-Object { $_ -notmatch $binarySkip }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$changed = 0

foreach ($f in $files) {
    if (-not (Test-Path $f)) { continue }
    $content = [System.IO.File]::ReadAllText($f)
    $orig = $content
    foreach ($r in $replacements) {
        $content = $content.Replace($r.Find, $r.Replace)
    }
    if ($content -ne $orig) {
        [System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
        $changed++
        Write-Host "updated: $f"
    }
}

Write-Host ""
Write-Host "$changed files updated"
