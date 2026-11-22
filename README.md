# Shulker

A Windows terminal app for finding large folders and reviewing developer artifacts. Requires Python 3.12 or later. Run these commands from this folder in PowerShell.

```powershell
python .\shulker.py
python .\shulker.py "C:\path\to\projects"
python .\shulker.py "C:\path\to\projects" --report
```

The default scope is your home folder. Start with a projects folder for a quicker scan. Press **L** to jump to the largest folders, **Enter** to drill down, and **Tab** to switch between the folder browser and cleanup candidates. **O** opens the selected folder in Explorer.

Each cleanup candidate shows the evidence used to classify it and what you may need to rebuild. Press **X** and confirm with **Y** to ask Windows to recycle a candidate. For a **Review** item, inspect the folder before confirming. Cancel if Windows offers permanent deletion.

The dot bar shows the share of scanned bytes in cleanup candidates or immediate subfolders, depending on the view. Sizes are logical file lengths and may differ from actual disk usage because of compression, sparse files, or hard links. Recycled items still occupy space on the drive. The scanner skips reparse points and unreadable entries and shows a skipped count.
