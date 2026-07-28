#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# OpenPrintHQ Cloud Client — outbound-allow helper (Linux/macOS).
#
# The connector is OUTBOUND-ONLY and needs no inbound ports. Most Linux/macOS
# hosts allow outbound by default, so this is usually a no-op. On hosts with a
# default-deny egress policy, uncomment the block matching your firewall.
set -eu

echo "OpenPrintHQ connector is outbound-only - no inbound ports required."

# --- ufw (Debian/Ubuntu), if you run a default-deny outbound policy ---------
# sudo ufw allow out to any port 443 proto tcp
# sudo ufw reload

# --- firewalld (Fedora/RHEL) ------------------------------------------------
# sudo firewall-cmd --permanent --direct --add-rule ipv4 filter OUTPUT 0 \
#   -p tcp --dport 443 -j ACCEPT
# sudo firewall-cmd --reload

# --- macOS pf: outbound is allowed by default; nothing to do ----------------

echo "Nothing to change on a default (allow-outbound) firewall."
