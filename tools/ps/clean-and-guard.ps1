# clean-and-guard.ps1
# 1) Clean markers; 2) Fail if any remain (for CI/pre-commit use)

$ErrorActionPreference = 'Stop'

# Include the cleaner script logic inline (no external dependency)
$files = Get-ChildItem -Recurse -File -Include *.js,*.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\build\\|\\.next\\|\\out\\|\\artifacts\\|\\cache\\' }

[int]$changed = 0
foreach ($f in $files) {
  $txt = Get-Content $f.FullName -Raw
  $txt2 = [regex]::Replace($txt, '\s*-\s*[A-Za-z0-9._-]+\.js:[0-9]+\b', '')
  $txt2 = [regex]::Replace($txt2, '\s*\(\s*[A-Za-z0-9._-]+\.js:[0-9]+\s*\)', '')
  if ($txt2 -ne $txt) {
    [System.IO.File]::WriteAllText($f.FullName, $txt2, (New-Object System.Text.UTF8Encoding($false)))
    $changed++
  }
}

if ($changed -gt 0) { Write-Host "Cleaned $changed file(s)." }

# Guard: if any markers remain, exit 1
$remaining = Select-String -Path ($files | Select-Object -Expand FullName) -Pattern '-\s*[A-Za-z0-9._-]+\.js:[0-9]+\b','\(\s*[A-Za-z0-9._-]+\.js:[0-9]+\s*\)' -ErrorAction SilentlyContinue
if ($remaining) {
  Write-Host "Markers still present:" -ForegroundColor Red
  $remaining | Sort-Object Path, LineNumber | Format-Table -AutoSize
  exit 1
} else {
  Write-Host "No markers present." -ForegroundColor Green
}
