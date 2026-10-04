# Hardening a fresh VPS

Done once, on 2026-10-04, for the Contabo VPS that will run LiveKit (Cloud VPS
4, US Central, Ubuntu 24.04, `209.145.50.128`). Written down so the next VPS is
the same ten minutes, and so nobody has to guess why a line is where it is.

The box arrives with `root` reachable by password. The goal is: key-only SSH, a
non-root user, a firewall that starts closed, and Docker. Nothing else.

## 1. A key that exists only for this machine

On the workstation, not on the VPS:

```sh
ssh-keygen -t ed25519 -N "" -C "<who>@<what> (<date>)" -f ~/.ssh/<name>
ssh-copy-id -i ~/.ssh/<name>.pub root@<ip>      # the one time the password is typed
```

Contabo only lets you add a key in the panel *after* the order, so the password
exists at first. `ssh-copy-id` asks for it on the terminal, which keeps it out of
chat logs and shell history.

## 2. A user that is not root

```sh
adduser --disabled-password --gecos "deploy" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
usermod -aG sudo deploy
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-deploy && chmod 440 /etc/sudoers.d/90-deploy
visudo -cf /etc/sudoers.d/90-deploy
```

`NOPASSWD` is deliberate: the account has no password at all (`--disabled-password`),
so the key is the only credential. A sudo password would just be a second secret
to store.

**Log in as `deploy` and run `sudo -n true` before going on.** Everything below
assumes this works.

## 3. Key-only SSH, with a way back

Ubuntu cloud images ship `50-cloud-init.conf` with `PasswordAuthentication yes`.
`sshd` takes the **first** value it reads, so the drop-in must sort before it —
hence `00-`. A file named `99-…` looks stronger and does nothing.

Arm a revert first, so a mistake locks nobody out for more than three minutes:

```sh
systemd-run --unit=revert-sshd-hardening --on-active=180 \
  /bin/sh -c 'rm -f /etc/ssh/sshd_config.d/00-hardening.conf; systemctl reload ssh'
```

```sh
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
EOF
sshd -t && systemctl reload ssh
sshd -T | grep -E '^(passwordauthentication|permitrootlogin) '   # both "no"
```

From a **new** connection, check all three: `deploy` with the key works; `root`
with the key is refused; a password attempt is refused with `publickey` as the
only method offered. Then cancel the revert:

```sh
systemctl stop revert-sshd-hardening.timer
```

The root password still works on the provider's VNC console, which is the
emergency door. It no longer opens SSH.

## 4. Firewall, closed by default

```sh
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment ssh        # allow SSH BEFORE enabling
ufw --force enable
```

Open each service's ports in the service's own runbook, not here. Docker
publishes ports through its own iptables chain and **bypasses ufw**: a
`ports:` entry in a compose file is open to the internet whether or not ufw
allows it. Publish only what the service needs, and read `docker ps` after a
deploy.

## 5. Docker

From Docker's own apt repository (Ubuntu's `docker.io` lags): `docker-ce`,
`docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`.
Add `deploy` to the `docker` group (that group is root-equivalent; acceptable on
a single-purpose box). Apply pending updates, then **reboot once** if
`/var/run/reboot-required` exists, and confirm after the boot: `ufw status` is
active, `docker run --rm hello-world` works without `sudo`, `sshd -T` still says
`no`.

## What this does not cover

- Backups: none ordered. The box holds no state worth keeping — LiveKit's config
  is in this repository and its keys are regenerated — so the right recovery is
  rebuilding, not restoring.
- Intrusion tools such as fail2ban: with passwords off, a brute-force attempt
  cannot succeed, only make noise in the log.
- Unattended upgrades are already enabled by the image.
