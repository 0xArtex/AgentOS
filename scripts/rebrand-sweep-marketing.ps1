# Brand sweep for internal/Marketing/* (gitignored — not caught by main sweeps).
# Same replacement patterns as the main rebrand sweeps.

$ErrorActionPreference = "Stop"

$replacements = @(
    @{ Find = '@agntos/agentos'; Replace = '@palmyr/cli' },
    @{ Find = 'agntos.dev';      Replace = 'palmyr.ai' },
    @{ Find = '@agntoss';        Replace = '@Palmyr_ai' },
    @{ Find = 'agntoss';         Replace = 'Palmyr_ai' },
    @{ Find = 'AGENTOS_';        Replace = 'PALMYR_' },
    @{ Find = 'AgentOS';         Replace = 'Palmyr' }
)

# Bare-word `agentos` → `palmyr` (regex, word-boundary). Run after literal replacements
# above. Marketing docs don't reference the DB filename (agentos.db) or the
# CHECK-constraint enum value, so this is safe to apply broadly.
$baretReplace = $true

$files = Get-ChildItem -Path 'internal/Marketing' -Recurse -File -Include '*.md'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$changed = 0

foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName)
    $orig = $content
    foreach ($r in $replacements) {
        $content = $content.Replace($r.Find, $r.Replace)
    }
    if ($baretReplace) {
        $content = [regex]::Replace($content, '\bagentos\b', 'palmyr')
    }
    if ($content -ne $orig) {
        [System.IO.File]::WriteAllText($f.FullName, $content, $utf8NoBom)
        $changed++
        Write-Host "updated: $($f.FullName.Replace($PWD.Path + [IO.Path]::DirectorySeparatorChar, ''))"
    }
}

Write-Host ""
Write-Host "$changed files updated"
