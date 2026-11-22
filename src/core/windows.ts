import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { dirname, join, parse } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function powershell(script: string, env = process.env) {
  return exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { env, windowsHide: true, timeout: 30000 });
}

interface DriveInfo {
  Name: string;
  Kind: "Fixed" | "Removable";
  DriveFormat: string;
  VolumeLabel: string;
}

/** Only ready local volumes are scanned. Explorer alone owns remote and optical volumes. */
export async function windowsDrives(): Promise<DriveInfo[]> {
  const { stdout } = await powershell(`
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $drives = [IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -in 'Fixed','Removable' }
    $rows = $drives | Select-Object Name,@{N='Kind';E={"$($_.DriveType)"}},DriveFormat,VolumeLabel
    ConvertTo-Json -InputObject @($rows) -Compress
  `);
  return JSON.parse(stdout || "[]");
}

export interface WindowsUsage {
  bytes: number;
  denied: boolean;
}

/** A physical-directory walk using logical file lengths. Windows Node does not expose allocated blocks. */
export async function windowsUsage(
  path: string,
  cancelled: () => boolean = () => false,
  visit?: (path: string, bytes: number) => void,
): Promise<WindowsUsage> {
  let denied = false;
  const walk = async (target: string, device: number): Promise<number> => {
    if (cancelled()) return 0;
    try {
      const info = await fsp.lstat(target);
      if (info.dev !== device || info.isSymbolicLink()) return 0;
      if (!info.isDirectory()) return info.isFile() ? info.size : 0;
      let bytes = 0;
      for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
        if (cancelled()) break;
        if (!entry.isSymbolicLink()) bytes += await walk(join(target, entry.name), device);
      }
      visit?.(target, bytes);
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") denied = true;
      return 0;
    }
  };
  try {
    const info = await fsp.lstat(path);
    return { bytes: await walk(path, info.dev), denied };
  } catch (error) {
    return { bytes: 0, denied: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
}

export async function verifyWindowsPath(path: string): Promise<void> {
  if (!/^[a-z]:[\\/]/i.test(path)) throw new Error("Choose a local Windows drive path.");
  for (let part = path; ; part = dirname(part)) {
    if ((await fsp.lstat(part)).isSymbolicLink()) throw new Error("The item is on a junction or symbolic link.");
    if (part === parse(part).root) break;
  }
}

const RECYCLE = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class ShulkerRecycle {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {}

  [ComVisible(true), Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int result);
    [PreserveSig] int PreRenameItem(uint flags, IntPtr item, IntPtr name);
    [PreserveSig] int PostRenameItem(uint flags, IntPtr item, IntPtr name, int result, IntPtr created);
    [PreserveSig] int PreMoveItem(uint flags, IntPtr item, IntPtr folder, IntPtr name);
    [PreserveSig] int PostMoveItem(uint flags, IntPtr item, IntPtr folder, IntPtr name, int result, IntPtr created);
    [PreserveSig] int PreCopyItem(uint flags, IntPtr item, IntPtr folder, IntPtr name);
    [PreserveSig] int PostCopyItem(uint flags, IntPtr item, IntPtr folder, IntPtr name, int result, IntPtr created);
    [PreserveSig] int PreDeleteItem(uint flags, IntPtr item);
    [PreserveSig] int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr created);
    [PreserveSig] int PreNewItem(uint flags, IntPtr folder, IntPtr name);
    [PreserveSig] int PostNewItem(uint flags, IntPtr folder, IntPtr name, IntPtr template, uint attributes, int result, IntPtr created);
    [PreserveSig] int UpdateProgress(uint total, uint done);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }

  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  public sealed class RecycleOnly : IFileOperationProgressSink {
    public bool Recycled { get; private set; }
    public int StartOperations() { return 0; }
    public int FinishOperations(int result) { return 0; }
    public int PreRenameItem(uint flags, IntPtr item, IntPtr name) { return 0; }
    public int PostRenameItem(uint flags, IntPtr item, IntPtr name, int result, IntPtr created) { return 0; }
    public int PreMoveItem(uint flags, IntPtr item, IntPtr folder, IntPtr name) { return 0; }
    public int PostMoveItem(uint flags, IntPtr item, IntPtr folder, IntPtr name, int result, IntPtr created) { return 0; }
    public int PreCopyItem(uint flags, IntPtr item, IntPtr folder, IntPtr name) { return 0; }
    public int PostCopyItem(uint flags, IntPtr item, IntPtr folder, IntPtr name, int result, IntPtr created) { return 0; }
    public int PreDeleteItem(uint flags, IntPtr item) {
      const uint recycleRequested = 0x80;
      const int abort = unchecked((int)0x80004004);
      return (flags & recycleRequested) != 0 ? 0 : abort;
    }
    public int PostDeleteItem(uint flags, IntPtr item, int result, IntPtr created) {
      Recycled = result >= 0 && created != IntPtr.Zero;
      return 0;
    }
    public int PreNewItem(uint flags, IntPtr folder, IntPtr name) { return 0; }
    public int PostNewItem(uint flags, IntPtr folder, IntPtr name, IntPtr template, uint attributes, int result, IntPtr created) { return 0; }
    public int UpdateProgress(uint total, uint done) { return 0; }
    public int ResetTimer() { return 0; }
    public int PauseTimer() { return 0; }
    public int ResumeTimer() { return 0; }
  }

  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    void Advise(); void Unadvise();
    [PreserveSig] int SetOperationFlags(uint flags);
    void SetProgressMessage(); void SetProgressDialog(); void SetProperties(); void SetOwnerWindow();
    void ApplyPropertiesToItem(); void ApplyPropertiesToItems(); void RenameItem(); void RenameItems();
    void MoveItem(); void MoveItems(); void CopyItem(); void CopyItems();
    [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
    void DeleteItems(); void NewItem();
    [PreserveSig] int PerformOperations();
    [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid,
    out IShellItem item);

  public static void Send(string path) {
    var drive = new DriveInfo(Path.GetPathRoot(path));
    if (drive.DriveType != DriveType.Fixed || drive.DriveFormat != "NTFS")
      throw new IOException("Recycle Bin is supported only on fixed NTFS drives.");
    for (string part = path; !String.IsNullOrEmpty(part); part = Path.GetDirectoryName(part)) {
      if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0)
        throw new IOException("The item is on a Windows reparse point.");
    }
    var pending = new Stack<string>();
    pending.Push(path);
    while (pending.Count > 0) {
      var child = pending.Pop();
      var attributes = File.GetAttributes(child);
      if ((attributes & FileAttributes.ReparsePoint) != 0)
        throw new IOException("This item contains a Windows reparse point.");
      string extension = Path.GetExtension(child).ToLowerInvariant();
      if (extension == ".vhd" || extension == ".vhdx" || extension == ".vmdk" || extension == ".qcow2")
        throw new IOException("This item contains a protected virtual disk.");
      if ((attributes & FileAttributes.Directory) != 0) {
        foreach (var entry in Directory.EnumerateFileSystemEntries(child)) pending.Push(entry);
      }
    }

    var itemId = typeof(IShellItem).GUID;
    IShellItem item;
    SHCreateItemFromParsingName(path, IntPtr.Zero, ref itemId, out item);
    var operationType = Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09"));
    try {
      var operation = (IFileOperation) Activator.CreateInstance(operationType);
      try {
        const uint addUndoRecord = 0x20000000;
        const uint recycleOnDelete = 0x00080000;
        const uint earlyFailure = 0x00100000;
        const uint noErrorUi = 0x0400;
        const uint silent = 0x0004;
        const uint noConfirmation = 0x0010;
        var sink = new RecycleOnly();
        Marshal.ThrowExceptionForHR(operation.SetOperationFlags(addUndoRecord | recycleOnDelete | earlyFailure | noErrorUi | silent | noConfirmation));
        Marshal.ThrowExceptionForHR(operation.DeleteItem(item, sink));
        Marshal.ThrowExceptionForHR(operation.PerformOperations());
        bool aborted;
        Marshal.ThrowExceptionForHR(operation.GetAnyOperationsAborted(out aborted));
        if (aborted || !sink.Recycled || File.Exists(path) || Directory.Exists(path))
          throw new IOException("Windows did not recycle this item.");
      } finally {
        Marshal.ReleaseComObject(operation);
      }
    } finally {
      Marshal.ReleaseComObject(item);
    }
  }
}
`;

/** Request recycling explicitly. There is no permanent-delete fallback. */
export async function recycleWindows(path: string): Promise<void> {
  await verifyWindowsPath(path);
  try {
    await powershell(`
      $ErrorActionPreference = 'Stop'
      Add-Type -TypeDefinition @'
${RECYCLE}
'@
      [ShulkerRecycle]::Send($env:SHULKER_RECYCLE_PATH)
    `, { ...process.env, SHULKER_RECYCLE_PATH: path });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr?.split(/\r?\n/)[0] || "Windows could not recycle this item.");
  }
}
