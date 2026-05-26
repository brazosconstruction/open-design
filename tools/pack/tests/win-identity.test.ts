import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { resolveWinInstallIdentity } from "../src/win/identity.js";

describe("resolveWinInstallIdentity", () => {
  it("keeps the default namespace on the canonical Windows display name", () => {
    expect(resolveWinInstallIdentity({ namespace: "default" })).toMatchObject({
      displayName: "Open Design",
      exeName: "Open Design.exe",
      shortcutName: "Open Design.lnk",
      uninstallerName: "Uninstall Open Design.exe",
    });
  });

  it("uses the canonical Windows display name for stable release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-stable-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design.exe",
      displayName: "Open Design",
      exeName: "Open Design.exe",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-stable-win",
      shortcutName: "Open Design.lnk",
      uninstallerName: "Uninstall Open Design.exe",
    });
  });

  it("uses first-class beta display identity for beta release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-beta-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
      displayName: "Open Design Beta",
      exeName: "Open Design Beta.exe",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-beta-win",
      shortcutName: "Open Design Beta.lnk",
      uninstallerName: "Uninstall Open Design Beta.exe",
    });
  });

  it("keeps non-release beta-like namespaces isolated from the real beta channel identity", () => {
    expect(resolveWinInstallIdentity({ namespace: "beta-local-flow" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design beta-local-flow.exe",
      displayName: "Open Design beta-local-flow",
      exeName: "Open Design beta-local-flow.exe",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-beta-local-flow",
      shortcutName: "Open Design beta-local-flow.lnk",
      uninstallerName: "Uninstall Open Design beta-local-flow.exe",
    });
    expect(resolveWinInstallIdentity({ appVersion: "0.8.0-beta.2", namespace: "beta-local-flow" })).toMatchObject({
      displayName: "Open Design beta-local-flow",
      exeName: "Open Design beta-local-flow.exe",
    });
  });

  it("uses first-class preview display identity for preview release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-preview-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Preview.exe",
      displayName: "Open Design Preview",
      exeName: "Open Design Preview.exe",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-preview-win",
      shortcutName: "Open Design Preview.lnk",
      uninstallerName: "Uninstall Open Design Preview.exe",
    });
  });

  it("uses first-class nightly display identity for nightly release versions and namespaces", () => {
    expect(resolveWinInstallIdentity({
      appVersion: "0.8.0.nightly.2",
      namespace: "release-stable-win",
    })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Nightly.exe",
      displayName: "Open Design Nightly",
      exeName: "Open Design Nightly.exe",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-stable-win",
      shortcutName: "Open Design Nightly.lnk",
      uninstallerName: "Uninstall Open Design Nightly.exe",
    });
    expect(resolveWinInstallIdentity({ namespace: "release-nightly-win" })).toMatchObject({
      displayName: "Open Design Nightly",
      exeName: "Open Design Nightly.exe",
      shortcutName: "Open Design Nightly.lnk",
    });
  });

  it("keeps the registry DisplayName free of the package version", async () => {
    const source = await readFile(new URL("../src/win/custom-installer.ts", import.meta.url), "utf8");
    expect(source).toContain('WriteRegStr HKCU "${registryKey}" "DisplayName" "${productName}"');
    expect(source).not.toContain('"DisplayName" "${productName} \\${APP_VERSION}"');
  });

  it("checks the silent install target directory for running instances before overwriting files", async () => {
    const source = await readFile(new URL("../src/win/custom-installer.ts", import.meta.url), "utf8");
    const silentCheck = source.slice(source.indexOf("silent_check:"), source.indexOf("existing_install:"));
    expect(silentCheck).toContain("Call SetInstallRootExistsFlag");
    expect(silentCheck).toContain('StrCpy $RunningInstancesInstallRoot "$INSTDIR"');
    expect(silentCheck.indexOf('StrCpy $RunningInstancesInstallRoot "$INSTDIR"')).toBeLessThan(
      silentCheck.indexOf("Call DetectRunningInstances"),
    );
  });

  it("treats partial launcher roots as existing installs for overwrite", async () => {
    const source = await readFile(new URL("../src/win/custom-installer.ts", import.meta.url), "utf8");
    const installSection = source.slice(source.indexOf('Section "Install"'), source.indexOf("prepare_install_dir:"));

    expect(source).toContain('IfFileExists "$ExistingInstallLocation\\\\${exeName}" valid_existing_location 0');
    expect(source).toContain('IfFileExists "$ExistingInstallLocation\\\\install.json" valid_existing_location 0');
    expect(source).toContain('IfFileExists "$ExistingInstallLocation\\\\runtime.json" valid_existing_location 0');
    expect(source).toContain('IfFileExists "$ExistingInstallLocation\\\\versions\\\\*.*" valid_existing_location invalid_existing_location');
    expect(source).toContain("Function SetInstallRootExistsFlag");
    expect(installSection).toContain("Call SetInstallRootExistsFlag");
    expect(installSection).toContain('!insertmacro LOG_PATH_STATE "install_dir_before_install" "$INSTDIR"');
    expect(installSection.indexOf("Call SetInstallRootExistsFlag")).toBeLessThan(
      installSection.indexOf("Call RemoveInstallDir"),
    );
    expect(installSection).not.toContain('IfFileExists "$INSTDIR\\\\${exeName}" 0 prepare_install_dir');
  });

  it("checks the shared launcher install lock before installer file changes", async () => {
    const source = await readFile(new URL("../src/win/custom-installer.ts", import.meta.url), "utf8");
    const installSection = source.slice(source.indexOf('Section "Install"'), source.indexOf('SectionEnd', source.indexOf('Section "Install"')));
    const uninstallSection = source.slice(source.indexOf('Section "Uninstall"'), source.indexOf('SectionEnd', source.indexOf('Section "Uninstall"')));
    expect(source).toContain('GetFileAttributes(t "$INSTDIR\\\\state\\\\lock")');
    expect(installSection.indexOf("Call GuardInstallRootLockBeforeFileChanges")).toBeLessThan(
      installSection.indexOf("Call RemoveInstallDir"),
    );
    expect(installSection.indexOf("Call GuardInstallRootLockBeforeFileChanges")).toBeLessThan(
      installSection.indexOf("CreateDirectory \"$INSTDIR\""),
    );
    expect(uninstallSection.indexOf("Call un.GuardInstallRootLockBeforeFileChanges")).toBeLessThan(
      uninstallSection.indexOf("Call un.RemoveInstallDirContents"),
    );
  });

  it("aborts instead of extracting over an install root that cannot be removed", async () => {
    const source = await readFile(new URL("../src/win/custom-installer.ts", import.meta.url), "utf8");
    const removeInstallDir = source.slice(source.indexOf("Function RemoveInstallDir"), source.indexOf("FunctionEnd", source.indexOf("Function RemoveInstallDir")));
    const removeUninstallDir = source.slice(source.indexOf("Function un.RemoveInstallDirContents"), source.indexOf("FunctionEnd", source.indexOf("Function un.RemoveInstallDirContents")));

    expect(removeInstallDir).toContain('GetFileAttributes(t "$INSTDIR")');
    expect(removeInstallDir).toContain("install aborted: failed to remove existing install dir");
    expect(removeInstallDir).toContain("SetErrorLevel 1");
    expect(removeInstallDir).toContain("Abort \"Failed to remove the existing Open Design installation.");
    expect(removeInstallDir.indexOf("Call LogInstallerEvent")).toBeLessThan(
      removeInstallDir.indexOf("Abort \"Failed to remove the existing Open Design installation."),
    );

    expect(removeUninstallDir).toContain('GetFileAttributes(t "$INSTDIR")');
    expect(removeUninstallDir).toContain("uninstall aborted: failed to remove install dir");
    expect(removeUninstallDir).toContain("SetErrorLevel 1");
    expect(removeUninstallDir).toContain("Abort \"Failed to remove the Open Design installation.");
  });

  it("invokes the per-user uninstaller mode from tools-pack lifecycle", async () => {
    const source = await readFile(new URL("../src/win/lifecycle.ts", import.meta.url), "utf8");
    expect(source).toContain('return ["/currentuser", ...(config.silent ? ["/S"] : [])];');
    expect(source).toContain('invokeNsis(paths, registeredPaths.uninstallerPath, uninstallArgs(config), "uninstall")');
    expect(source).toContain('join(installDir, "state", "lock")');
    expect(source).toContain('assertNoLauncherInstallRootLock(registeredPaths.installDir, "uninstall launcher root")');
    expect(source).toContain('assertNoLauncherInstallRootLock(registeredPaths.installDir, "finish uninstall cleanup")');
  });

  it("waits for the NSIS uninstaller process before cleanup continues", async () => {
    const source = await readFile(new URL("../src/win/nsis.ts", import.meta.url), "utf8");
    expect(source).toContain("Start-Process -FilePath");
    expect(source).toContain("-Wait -PassThru");
    expect(source).toContain('action === "uninstall"');
  });
});
