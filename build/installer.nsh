; HomeCable installer extras (included by electron-builder).
; Channels, people and settings live in %APPDATA%\HomeCable — not in the program
; folder — so they survive reinstalling. These two questions let you choose.
; Your video files are never touched. Silent installs/updates keep everything.

; The license & fair-use agreement (build/license.txt) must be accepted with an
; explicit checkbox — installing is impossible without agreeing to it.
!macro customHeader
  !define MUI_LICENSEPAGE_CHECKBOX
  !define MUI_LICENSEPAGE_CHECKBOX_TEXT "I have read and agree — I'm responsible for what I play, and I won't use HomeCable for piracy or anything illegal."
!macroend

!macro customInstall
  IfFileExists "$APPDATA\HomeCable\settings.json" 0 hc_fresh_done
    MessageBox MB_YESNO|MB_ICONQUESTION "HomeCable has been set up on this PC before.$\r$\n$\r$\nKeep your channels, people and settings?$\r$\n$\r$\n  Yes  =  keep them, carry on where you left off$\r$\n  No   =  start fresh with the first-time setup$\r$\n$\r$\n(Your video files are never touched. Starting fresh keeps a copy of the old settings in $\"HomeCable (old settings)$\".)" /SD IDYES IDYES hc_fresh_done
      RMDir /r "$APPDATA\HomeCable (old settings)"
      Rename "$APPDATA\HomeCable" "$APPDATA\HomeCable (old settings)"
      ; If something kept it open, at least make the app start over.
      IfFileExists "$APPDATA\HomeCable\settings.json" 0 hc_fresh_done
        FileOpen $0 "$APPDATA\HomeCable\start-over" w
        FileClose $0
  hc_fresh_done:
!macroend

!macro customUnInstall
  ; App files the updater downloaded (only on a real uninstall — an update's
  ; own silent uninstall keeps them; the new version tidies them itself).
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\HomeCable\app-versions"
  ${endIf}
  IfFileExists "$APPDATA\HomeCable\settings.json" 0 hc_keep_done
    MessageBox MB_YESNO|MB_ICONQUESTION "Also remove your HomeCable channels, people and settings?$\r$\n$\r$\nYes  =  remove them (a new install starts from scratch)$\r$\nNo   =  keep them for next time$\r$\n$\r$\n(Your video files are never touched.)" /SD IDNO IDNO hc_keep_done
      RMDir /r "$APPDATA\HomeCable"
  hc_keep_done:
!macroend
