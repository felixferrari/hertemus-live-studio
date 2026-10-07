# HERTEMUS Live Studio — primeira etapa visual

Fork independente do OBS Studio. Prioridade: estabilidade, praticidade, identidade visual própria e compatibilidade com recursos existentes.

## Implementado

Três temas de verdade, em formato OBS Variant Theme (.ovt), herdando do Yami oficial (OBS 30.2+):

- HERTEMUS | Roxo — frontend/data/themes/Yami_Hertemus_Roxo.ovt
- HERTEMUS | Esmeralda — frontend/data/themes/Yami_Hertemus_Esmeralda.ovt
- HERTEMUS | Azul — frontend/data/themes/Yami_Hertemus_Azul.ovt

Os arquivos definem cores de superfícies, seleção, botões, abas, campos, rolagem, títulos de dock e hierarquia visual. O tema-base Yami não foi modificado.

## Limite da etapa

As imagens conceituais NÃO são telas executáveis. Um tema visual não implementa painel lateral novo, layout de docks, chat unificado, alertas ou multistream. Esses recursos terão implementação separada no frontend Qt/C++ e testes.

## Testar temas sem compilar e sem mexer no OBS principal (Windows)

1. Obtenha o ZIP oficial do OBS Studio para Windows; não execute um segundo instalador.
2. Extraia em C:\HERTEMUS-Live-Studio, ou outra pasta particular fora de Program Files.
3. Crie um arquivo vazio chamado portable_mode.txt na raiz da pasta extraída (a que tem bin e data). Verifique se o Windows não adicionou outro .txt ao nome.
4. Abra bin\64bit\obs64.exe dessa pasta; perfis, cenas e configurações passarão a ser locais da cópia portátil.
5. Copie os três arquivos .ovt do fork para data\obs-studio\themes da cópia portátil. Alternativamente rode tools\instalar-temas-portatil.ps1 com a pasta da cópia portátil.
6. No OBS portátil, vá a Configurações -> Aparência, escolha tema Yami e selecione o estilo HERTEMUS desejado.

Para desenvolvimento de temas no OBS 30.2+, a seção [Appearance] do user.ini pode receber AutoReload=true, habilitando recarga automática ao editar os temas ativos.

## Independência e cuidado

- Nunca sobrepor arquivos na instalação original usada nas lives.
- Temas e plugins devem estar apenas na cópia portátil de teste. Evitar plugins globais.
- OBS portátil isola perfis e cenas; não isola webcam, drivers, GPU ou contas online. Arquivos externos referenciados por cenas podem ser compartilhados por caminho.
- Referência oficial: https://obsproject.com/kb/portable-mode

## Etapas seguintes

1. Estúdio Essencial: layout real dos docks de cenas, fontes, prévia, mixer e controles, redimensionável e reversível.
2. Identidade: ícones e logotipo HERTEMUS originais, sem substituí-los no OBS de produção.
3. Módulos futuros: chat unificado, multistream, alertas e integrações, testados individualmente.

Não distribuir executável personalizado antes de compilar e testar o fork.