#!/usr/bin/env bash
# Usage: sudo bash bootstrap-vm.sh   (on the VM; safe to rerun)
# Patches and hardens a fresh Ubuntu VM on Oracle Cloud, opens its firewall to the cluster's own networks,
# and installs the pinned k3s.
set -euo pipefail

k3s_version=v1.36.5+k3s1
pod_cidr=10.42.0.0/16
service_cidr=10.43.0.0/16

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get -y install unattended-upgrades
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# sshd keeps the first value it reads, and the drop-ins are read in name order, so this beats
# cloud-init's 50-cloud-init.conf.
cat >/etc/ssh/sshd_config.d/00-jcool-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh || systemctl restart ssh

# Oracle's image ends INPUT and FORWARD with a REJECT, which drops pod-to-node and pod-to-pod traffic.
# The ACCEPTs go just above it, live and in rules.v4. netfilter-persistent save is not used: it would
# also persist the rules k3s writes at runtime.
rules=/etc/iptables/rules.v4
for chain in INPUT FORWARD; do
  for cidr in "$pod_cidr" "$service_cidr"; do
    if ! iptables -C "$chain" -s "$cidr" -j ACCEPT 2>/dev/null; then
      position=$(iptables -L "$chain" -n --line-numbers | awk '$2 == "REJECT" { print $1; exit }')
      if [ -n "$position" ]; then
        iptables -I "$chain" "$position" -s "$cidr" -j ACCEPT
      fi
    fi
    rule="-A $chain -s $cidr -j ACCEPT"
    if [ -f "$rules" ] && ! grep -qxF -- "$rule" "$rules"; then
      awk -v rule="$rule" -v prefix="-A $chain " '
        !done && index($0, prefix) == 1 && / -j REJECT/ { print rule; done = 1 }
        { print }
      ' "$rules" >"$rules.tmp"
      mv "$rules.tmp" "$rules"
    fi
  done
done

mkdir -p /etc/rancher/k3s
cat >/etc/rancher/k3s/config.yaml <<'EOF'
write-kubeconfig-mode: "0600"
secrets-encryption: true
disable:
  - traefik
  - servicelb
EOF

if [ "$(k3s --version 2>/dev/null | awk 'NR == 1 { print $3 }')" != "$k3s_version" ]; then
  # The installer of the same release, not get.k3s.io's latest.
  curl -sfL "https://raw.githubusercontent.com/k3s-io/k3s/${k3s_version/+/%2B}/install.sh" |
    INSTALL_K3S_VERSION=$k3s_version sh -
fi
until k3s kubectl get node >/dev/null 2>&1; do sleep 2; done
k3s kubectl wait --for=condition=Ready node --all --timeout=180s
k3s --version | head -1
