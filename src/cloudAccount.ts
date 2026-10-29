import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { CloudController } from "./cloud";
import { ConfirmModal } from "./confirmModal";
import { accountInfo, approveDevice, changePassword, deleteAccount, disableTotp, enableTotp, listApprovals, newRecoveryCode, rejectDevice, setupTotp } from "../cloud/shared/account.mjs";

type Device = { id: string; name: string; revoked?: boolean; lastSeenAt?: string };
type Approval = { id: string; words: string[] };
type Plan = { name: string; plusUntil?: string; deviceLimit: number; historyDays: number; subscribed?: boolean };

// A wrong password or code is also a 401; only "Device access denied" means this device lost access (as on the website).
const errorText = (error: unknown) => (error as { status?: number }).status === 401 && (!(error instanceof Error) || !error.message || error.message === "Device access denied")
  ? "This device no longer has access. Log out and log in again."
  : error instanceof Error ? error.message : "Something went wrong. Try again.";

/**
 * Plan, devices, approvals and security for a signed-in device, like "Devices & recovery" on the website.
 * Returns a function that stops the approval check when the settings close.
 */
export function renderCloudAccount(app: App, el: HTMLElement, cloud: CloudController): () => void {
  const client = cloud.connection;
  if (!client) return () => {};
  const plan = el.createDiv();
  const approvals = el.createDiv();
  const devices = el.createDiv();
  const security = el.createDiv();
  let stopped = false;

  const showPlan = async () => {
    try {
      const status = await client.status() as { usedBytes: number; quotaBytes: number; plan: Plan };
      if (stopped) return;
      plan.empty();
      const p = status.plan;
      const name = p.name === "plus" && p.plusUntil ? `JotDrop Plus until ${new Date(p.plusUntil).toLocaleDateString()}` : `Free plan: ${p.deviceLimit} devices, ${p.historyDays} days of history`;
      const origin = client.credentials.url;
      new Setting(plan).setName("Plan").setDesc(`${name}. ${(status.usedBytes / 1048576).toFixed(1)} of ${(status.quotaBytes / 1048576).toFixed(0)} MiB encrypted storage used.`)
        .addButton((button) => button.setButtonText(p.name === "plus" ? "Open the website" : "JotDrop Plus on the website").onClick(() => window.open(origin, "_blank")));
      // Like the website: findable, but out of the way.
      if (p.subscribed) {
        const details = plan.createEl("details", { cls: "jotdrop-cloud-subscription" });
        details.createEl("summary", { text: "Subscription" });
        details.createEl("p", { text: "Manage or cancel your subscription at link.com." });
      }
    } catch (error) { plan.empty(); plan.createEl("p", { text: errorText(error) }); }
  };

  const showApprovals = async () => {
    let list: Approval[] = [];
    try { list = await listApprovals(client); }
    catch (error) { if ((error as { status?: number }).status !== 404) { approvals.empty(); approvals.createEl("p", { text: errorText(error) }); return; } }
    if (stopped) return;
    approvals.empty();
    for (const approval of list) {
      const words = approval.words.join(" ");
      new Setting(approvals).setName("A new device asks for access").setDesc(`Approve only if the new device shows exactly these words: ${words}`)
        .addButton((button) => button.setButtonText("Reject").setWarning().onClick(async () => {
          try { await rejectDevice(client, approval.id); } catch (error) { new Notice(errorText(error)); }
          await showApprovals();
        }))
        .addButton((button) => button.setButtonText("Approve").setCta().onClick(() => {
          new ConfirmModal(app, { title: "Same four words?", message: `Does the new device show exactly these words?\n\n${words}`, confirmLabel: "Yes, approve" }, async () => {
            try { await approveDevice(client, approval); new Notice("Approved. The new device can now open your notes."); }
            catch (error) { new Notice(errorText(error)); }
            await showApprovals();
          }).open();
        }));
    }
  };

  const showDevices = async () => {
    try {
      const result = await client.devices() as { devices: Device[] };
      if (stopped) return;
      devices.empty();
      new Setting(devices).setName("Devices").setHeading();
      for (const device of result.devices) {
        const current = device.id === client.credentials.deviceId;
        const row = new Setting(devices).setName(`${device.name}${current ? " (this device)" : ""}`)
          .setDesc(device.revoked ? "Access revoked" : device.lastSeenAt ? `Last used ${new Date(device.lastSeenAt).toLocaleDateString()}` : "");
        if (!device.revoked && !current) row.addButton((button) => button.setButtonText("Revoke access").setWarning().onClick(() => {
          new ConfirmModal(app, { title: `Revoke access for ${device.name}?`, message: "That device can no longer reach your cloud. Notes already on it stay there.", confirmLabel: "Revoke access", destructive: true }, async () => {
            try { await client.revokeDevice(device.id); } catch (error) { new Notice(errorText(error)); }
            await showDevices();
          }).open();
        }));
      }
      new Setting(devices).setName("Add a device without an account").setDesc("Makes a one-time pairing code, like the website and the Android app.")
        .addButton((button) => button.setButtonText("Make pairing code").onClick(() => new PairingModal(app, cloud).open()));
    } catch (error) { devices.empty(); devices.createEl("p", { text: errorText(error) }); }
  };

  const showSecurity = async () => {
    let account: { email: string; password: boolean; totp: boolean } | undefined;
    try { account = await accountInfo(client); } catch (error) { if ((error as { status?: number }).status !== 404) return; }
    if (stopped) return;
    security.empty();
    new Setting(security).setName("Password and recovery").setHeading();
    const hasPassword = !!account?.password;
    // An account made with Google or GitHub gets a password through "Forgot password", like on the website.
    if (account && !hasPassword) {
      security.createEl("p", { text: "You sign in with Google or GitHub, so this account has no password. A password is needed to make a new recovery code. To add one: log out, choose \"Forgot password?\" and follow the steps." });
    } else {
      if (account) new Setting(security).setName("Password").setDesc("Changing it does not encrypt your notes again.")
        .addButton((button) => button.setButtonText("Change password").onClick(() => new PasswordModal(app, cloud).open()));
      if (account) {
        const totp = account.totp;
        new Setting(security).setName("Authenticator app")
          .setDesc(totp ? "On: a new device asks for a code from your app." : "Off: a new device asks for a code by email.")
          .addButton((button) => button.setButtonText(totp ? "Turn off" : "Set up an authenticator app").onClick(() => {
            if (totp) new TurnOffAuthenticatorModal(app, cloud, () => void showSecurity()).open();
            else new AuthenticatorModal(app, cloud, { onChange: () => void showSecurity() }).open();
          }));
      }
      new Setting(security).setName("Recovery code").setDesc("Make a new code if the old one is lost. The old code stops working.")
        .addButton((button) => button.setButtonText("Make a new recovery code").onClick(() => new NewRecoveryModal(app, cloud, !!account).open()));
    }
    new Setting(security).setName("Delete account").setDesc("Deletes your JotDrop Cloud and account. The notes in this vault stay.")
      .addButton((button) => button.setButtonText("Delete account").setWarning().onClick(() => new DeleteAccountModal(app, cloud, hasPassword).open()));
  };

  void showPlan();
  void showApprovals();
  void showDevices().then(showSecurity);
  // A request from a new device waits here while the settings are open.
  const timer = window.setInterval(() => { if (!stopped) void showApprovals(); }, 5000);
  return () => { stopped = true; window.clearInterval(timer); };
}

/** Shown once: the recovery code is the way back in when no signed-in device is left (accounts made with Google have no password). `then` runs after "Done". */
export class RecoveryCodeModal extends Modal {
  constructor(app: App, private code: string, private then?: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText("Save your recovery code");
    this.contentEl.createEl("p", { text: "If you lose access to all your signed-in devices, this code may be the only way back into your notes. Store it in a password manager. Nobody, including JotDrop, can recover your notes without it." });
    const box = this.contentEl.createEl("textarea", { cls: "jotdrop-recovery-code", attr: { readonly: "", rows: "4", "aria-label": "Recovery code" } });
    box.value = this.code;
    // Through the component: Obsidian ignores clicks on a button it still thinks is disabled.
    let finish!: ButtonComponent;
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Copy").onClick(async () => { await navigator.clipboard.writeText(this.code); new Notice("Recovery code copied."); }));
    new Setting(this.contentEl).setName("I saved my recovery code").addToggle((toggle) => toggle.onChange((value) => { finish.setDisabled(!value); }));
    new Setting(this.contentEl).addButton((button) => { finish = button; button.setButtonText("Done").setCta().setDisabled(true).onClick(() => { this.close(); this.then?.(); }); });
  }
  onClose(): void { this.contentEl.empty(); }
}

abstract class FormModal extends Modal {
  protected message!: HTMLElement;
  constructor(app: App, protected cloud: CloudController) { super(app); }
  protected password(name: string, autocomplete: AutoFill, set: (value: string) => void): void {
    new Setting(this.contentEl).setName(name).addText((input) => { input.inputEl.type = "password"; input.inputEl.autocomplete = autocomplete; input.onChange(set); });
  }
  protected submit(label: string, action: () => Promise<void>): void {
    this.message = this.contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(this.contentEl).addButton((button) => button.setButtonText(label).setCta().onClick(async () => {
      button.setDisabled(true);
      this.message.setText("Working securely on this device...");
      try { await action(); }
      catch (error) { this.message.setText(errorText(error)); }
      finally { button.setDisabled(false); }
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class PasswordModal extends FormModal {
  onOpen(): void {
    this.titleEl.setText("Change password");
    let current = "", next = "", repeat = "", signOut = false;
    this.password("Current password", "current-password", (value) => { current = value; });
    this.password("New password", "new-password", (value) => { next = value; });
    this.password("Repeat new password", "new-password", (value) => { repeat = value; });
    new Setting(this.contentEl).setName("Sign out my other devices").setDesc("They log in again with the new password.").addToggle((toggle) => toggle.onChange((value) => { signOut = value; }));
    this.submit("Change password", async () => {
      if (next !== repeat) throw new Error("The new passwords do not match.");
      const client = this.cloud.connection;
      if (!client) throw new Error("Log in first.");
      await changePassword(client, { currentPassword: current, newPassword: next, signOutOtherDevices: signOut });
      this.close();
      new Notice("Password changed. Your notes did not need to be encrypted again.");
    });
  }
}

class NewRecoveryModal extends FormModal {
  constructor(app: App, cloud: CloudController, private hasAccount: boolean) { super(app, cloud); }
  onOpen(): void {
    this.titleEl.setText("Make a new recovery code");
    this.contentEl.createEl("p", { text: "The old recovery code stops working as soon as the new one is made." });
    let current = "";
    if (this.hasAccount) this.password("Password", "current-password", (value) => { current = value; });
    this.submit("Make a new recovery code", async () => {
      const client = this.cloud.connection;
      if (!client) throw new Error("Log in first.");
      const code = await newRecoveryCode(client, this.hasAccount ? { password: current } : {});
      this.close();
      new RecoveryCodeModal(this.app, code).open();
    });
  }
}

class DeleteAccountModal extends FormModal {
  constructor(app: App, cloud: CloudController, private hasPassword: boolean) { super(app, cloud); }
  onOpen(): void {
    this.titleEl.setText("Delete account");
    this.contentEl.createEl("p", { text: "This deletes your JotDrop Cloud: every note and version stored there, your account and the devices signed in to it. A running JotDrop Plus subscription is cancelled. The notes in this vault stay. This cannot be undone." });
    let current = "", typed = "";
    if (this.hasPassword) this.password("Password", "current-password", (value) => { current = value; });
    new Setting(this.contentEl).setName("Type DELETE to confirm").addText((input) => input.onChange((value) => { typed = value.trim(); }));
    this.message = this.contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Delete my account and cloud").setWarning().onClick(async () => {
      if (typed !== "DELETE") { this.message.setText("Type DELETE to confirm."); return; }
      const client = this.cloud.connection;
      if (!client) { this.message.setText("Log in first."); return; }
      button.setDisabled(true);
      this.message.setText("Deleting...");
      try {
        await deleteAccount(client, this.hasPassword ? { password: current } : {});
        await this.cloud.forgetDeletedCloud();
        this.close();
        new Notice("Your account and cloud were deleted. Your notes stay in this vault.");
      } catch (error) { this.message.setText(errorText(error)); }
      finally { button.setDisabled(false); }
    }));
  }
}

class PairingModal extends FormModal {
  onOpen(): void {
    this.titleEl.setText("Make a pairing code");
    this.contentEl.createEl("p", { text: "Keep the code private. It works once and expires soon." });
    let name = "";
    new Setting(this.contentEl).setName("Name of the new device").addText((input) => input.setPlaceholder("For example: Work laptop").onChange((value) => { name = value.trim(); }));
    this.submit("Make pairing code", async () => {
      const client = this.cloud.connection;
      if (!client) throw new Error("Log in first.");
      const { pairingCode, expiresAt } = await client.makePairing(name || "New device");
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: `Use this code once on the new device before ${new Date(expiresAt).toLocaleTimeString()}.` });
      const box = this.contentEl.createEl("textarea", { cls: "jotdrop-recovery-code", attr: { readonly: "", rows: "4", "aria-label": "Pairing code" } });
      box.value = pairingCode;
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Copy").onClick(async () => { await navigator.clipboard.writeText(pairingCode); new Notice("Pairing code copied."); }))
        .addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()));
    });
  }
}

/** Draws the server's QR rows ("1" = dark), dark on white with a quiet zone in every theme, so any authenticator app can scan it. */
function drawQr(parent: HTMLElement, rows: string[]): void {
  const size = rows.length + 8;
  const svg = parent.createSvg("svg", { cls: "jotdrop-qr", attr: { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": "QR code for your authenticator app", "shape-rendering": "crispEdges" } });
  svg.createSvg("rect", { attr: { width: size, height: size, fill: "#fff" } });
  svg.createSvg("path", { attr: { fill: "#000", d: rows.flatMap((row, y) => [...row].map((dark, x) => (dark === "1" ? `M${x + 4} ${y + 4}h1v1h-1z` : ""))).join("") } });
}

/**
 * Sets up an authenticator app. With `password` it is the recommended step right after signing up
 * (the password was just typed); without it, from the settings, where the password is asked again.
 */
export class AuthenticatorModal extends FormModal {
  constructor(app: App, cloud: CloudController, private options: { password?: string; onChange?: () => void } = {}) { super(app, cloud); }
  onOpen(): void {
    if (this.options.password === undefined) { void this.setup(); return; }
    this.titleEl.setText("Secure your account with an authenticator app (recommended)");
    this.intro();
    this.contentEl.createEl("p", { cls: "setting-item-description", text: "You can also do this later in the JotDrop Cloud settings." });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Later").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Set up now").setCta().onClick(() => void this.setup()));
  }
  private intro(): void {
    this.contentEl.createEl("p", { text: "An authenticator app, like Google Authenticator, Microsoft Authenticator or 2FAS, shows a new 6-digit code every 30 seconds. With one set up, a new device asks for that code instead of a code by email, so your account stays safe even if someone gets into your email." });
  }
  private async setup(): Promise<void> {
    const client = this.cloud.connection;
    const fromSettings = this.options.password === undefined;
    this.contentEl.empty();
    this.titleEl.setText("Set up an authenticator app");
    if (!client) { this.contentEl.createEl("p", { text: "Log in first." }); return; }
    let setup: { secret: string; qr: string[] };
    try { setup = await setupTotp(client); }
    catch (error) { this.contentEl.createEl("p", { text: errorText(error) }); return; }
    if (fromSettings) this.intro();
    this.contentEl.createEl("p", { text: "Scan this QR code with your authenticator app, then enter the code it shows. No camera? Choose \"enter a setup key\" in the app and type the key below." });
    drawQr(this.contentEl, setup.qr);
    new Setting(this.contentEl).setName("Setup key").setDesc(setup.secret)
      .addButton((button) => button.setButtonText("Copy").onClick(async () => { await navigator.clipboard.writeText(setup.secret); new Notice("Setup key copied."); }));
    let code = "", password = this.options.password ?? "";
    new Setting(this.contentEl).setName("Code from the app").addText((input) => { input.inputEl.inputMode = "numeric"; input.inputEl.autocomplete = "one-time-code"; input.onChange((value) => { code = value.trim(); }); });
    if (fromSettings) this.password("Password", "current-password", (value) => { password = value; });
    this.submit("Turn on", async () => {
      await enableTotp(client, { password, code });
      this.close();
      new Notice("Authenticator app turned on. A new device now asks for a code from the app.");
      this.options.onChange?.();
    });
  }
  onClose(): void { this.options.password = undefined; super.onClose(); }
}

class TurnOffAuthenticatorModal extends FormModal {
  constructor(app: App, cloud: CloudController, private onChange: () => void) { super(app, cloud); }
  onOpen(): void {
    this.titleEl.setText("Turn off the authenticator app");
    this.contentEl.createEl("p", { text: "A new device then asks for a code by email instead." });
    let current = "";
    this.password("Password", "current-password", (value) => { current = value; });
    this.submit("Turn off", async () => {
      const client = this.cloud.connection;
      if (!client) throw new Error("Log in first.");
      await disableTotp(client, { password: current });
      this.close();
      new Notice("Authenticator app turned off. New devices get a code by email.");
      this.onChange();
    });
  }
}
