import { exec, getExecOutput } from "@actions/exec";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Reads a colon-delimited field from `gpg --with-colons` output.
function colonField(output, recordPrefix, index) {
  for (const line of output.split("\n")) {
    if (line.startsWith(recordPrefix)) return line.split(":")[index];
  }
  return "";
}

async function gitConfig(key, value) {
  await exec("git", ["config", key, value]);
}

async function configureGpg(core, privateKey, passphrase) {
  // Key is passed on stdin so it never appears in a logged command line.
  await exec("gpg", ["--batch", "--import"], { input: Buffer.from(privateKey) });

  const { stdout } = await getExecOutput(
    "gpg",
    ["--batch", "--list-secret-keys", "--with-colons", "--with-keygrip"],
    { silent: true },
  );
  const keyId = colonField(stdout, "sec:", 4);
  const keygrip = colonField(stdout, "grp:", 9);

  await gitConfig("user.signingkey", keyId);
  await gitConfig("commit.gpgsign", "true");
  await gitConfig("gpg.program", "gpg");

  if (passphrase) {
    // Preset the passphrase into the agent so signing is non-interactive.
    const gnupgHome = process.env.GNUPGHOME || path.join(os.homedir(), ".gnupg");
    fs.mkdirSync(gnupgHome, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(gnupgHome, "gpg-agent.conf"),
      "allow-loopback-pinentry\nallow-preset-passphrase\n",
    );
    await exec("gpgconf", ["--reload", "gpg-agent"]);
    const hex = Buffer.from(passphrase).toString("hex").toUpperCase();
    await exec("gpg-connect-agent", [`PRESET_PASSPHRASE ${keygrip} -1 ${hex}`, "/bye"]);
  }
}

async function configureSsh(sshKey) {
  const sshDir = path.join(os.homedir(), ".ssh");
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(sshDir, "backport_signing_key");
  fs.writeFileSync(keyPath, sshKey.endsWith("\n") ? sshKey : `${sshKey}\n`, { mode: 0o600 });

  await gitConfig("gpg.format", "ssh");
  await gitConfig("user.signingkey", keyPath);
  await gitConfig("commit.gpgsign", "true");
}

// Configures git to sign cherry-picked commits when a key is provided.
// Returns true if signing was enabled. GPG takes precedence over SSH.
async function configureSigning(core, signing) {
  if (signing.gpgPrivateKey) {
    core.setSecret(signing.gpgPrivateKey);
    if (signing.gpgPassphrase) core.setSecret(signing.gpgPassphrase);
    await configureGpg(core, signing.gpgPrivateKey, signing.gpgPassphrase);
    return true;
  }
  if (signing.sshSigningKey) {
    core.setSecret(signing.sshSigningKey);
    await configureSsh(signing.sshSigningKey);
    return true;
  }
  return false;
}

export { configureSigning };
