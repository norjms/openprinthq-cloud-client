// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenPrintHQ Cloud Client — desktop entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    openprinthq_cloud_client_lib::run();
}
