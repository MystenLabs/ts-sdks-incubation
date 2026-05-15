Output .codex-real-video/wallet-tui.mp4

Require node

Set Shell "zsh"
Set FontSize 16
Set FontFamily "Menlo"
Set Width 1280
Set Height 720
Set Padding 20
Set Framerate 30
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"
Set LetterSpacing 0
Set LineHeight 1.2
Set WindowBar Colorful
Set TypingSpeed 20ms

Type "DEVSTACK_STACK=video node ../../packages/devstack/dist/cli/main.mjs up --renderer tui"
Enter
Sleep 18s
Ctrl+C
Sleep 2s
