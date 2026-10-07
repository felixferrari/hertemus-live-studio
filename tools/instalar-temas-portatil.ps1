# Instala os temas somente na copia portatil do OBS para Windows.
# Exemplo:
# powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\instalar-temas-portatil.ps1 -RaizPortatil "C:\HERTEMUS-Live-Studio"
param(
    [Parameter(Mandatory = $true)]
    [string]$RaizPortatil
)

$ErrorActionPreference = "Stop"
$raiz = [System.IO.Path]::GetFullPath($RaizPortatil)
if (-not (Test-Path -LiteralPath $raiz -PathType Container)) {
    throw "Pasta nao encontrada: $raiz"
}
$pastasProtegidas = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"))
foreach ($pastaProtegida in $pastasProtegidas) {
    if ($pastaProtegida -and ($raiz -eq $pastaProtegida -or $raiz.StartsWith($pastaProtegida + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Por seguranca, nao instale em Program Files. Use outra pasta."
    }
}
$marcador1 = Join-Path $raiz "portable_mode.txt"
$marcador2 = Join-Path $raiz "portable_mode"
if (-not ((Test-Path -LiteralPath $marcador1 -PathType Leaf) -or (Test-Path -LiteralPath $marcador2 -PathType Leaf))) {
    throw "Modo portatil nao detectado: crie portable_mode.txt na raiz da copia ZIP."
}
$binario = Join-Path $raiz "bin\64bit\obs64.exe"
if (-not (Test-Path -LiteralPath $binario -PathType Leaf)) {
    throw "Nao achei bin\64bit\obs64.exe. Informe a raiz da copia ZIP."
}
$origem = Join-Path $PSScriptRoot "..\frontend\data\themes"
$destino = Join-Path $raiz "data\obs-studio\themes"
$nomes = @(
    "Yami_Hertemus_Roxo.ovt",
    "Yami_Hertemus_Esmeralda.ovt",
    "Yami_Hertemus_Azul.ovt"
)
foreach ($nome in $nomes) {
    if (-not (Test-Path -LiteralPath (Join-Path $origem $nome) -PathType Leaf)) {
        throw "Nao achei o arquivo $nome no repositorio."
    }
}
New-Item -ItemType Directory -Path $destino -Force | Out-Null
foreach ($nome in $nomes) {
    Copy-Item -LiteralPath (Join-Path $origem $nome) -Destination (Join-Path $destino $nome) -Force
    Write-Host "Tema instalado: $nome"
}
Write-Host "Sucesso! Apenas a copia portatil foi alterada."
