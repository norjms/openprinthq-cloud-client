# Code signing

How OpenPrintHQ Cloud Client binaries are signed, what a signature does and does
not tell you, and how to verify a download yourself.

This document exists for two reasons. It is what a user should be able to read
before running an installer downloaded from the internet, and it is the
"code signing policy" that certificate authorities and OSS signing programmes
require a project to publish before they will issue it a certificate.

## The two signatures, and why they are not the same thing

There are two independent signatures in play, and conflating them is the usual
way projects end up believing they are protected when they are not.

**Authenticode (Windows) and Developer ID (macOS)** are about the *operating
system's* opinion of the installer. They answer "does the OS know who published
this, and will it warn the user before running it". They are user-facing trust.
They do nothing for an update the client installs on its own, because by then
nobody is reading a dialog.

**The updater signature (minisign, Tauri's own scheme)** is about *our* opinion
of an artifact. It answers "did this exact file come from our release pipeline".
It is what the auto-update path checks before it installs anything, and it is
the load-bearing signature for anyone whose client updates itself. It is
verified by the client, offline, against a public key compiled into the build.

A project can have one without the other. An unsigned MSI whose updater
signature is checked is safe to auto-update and scary to install by hand. A
beautifully Authenticode-signed MSI with no updater signature is pleasant to
install and completely unprotected against a tampered update feed.

## What is signed today

| Artifact | Authenticode / Developer ID | Updater signature |
|---|---|---|
| Windows `.msi` | not signed | not yet implemented |
| macOS `.pkg` | not signed, not notarized | not yet implemented |
| Linux `.deb` / `.rpm` | not signed | not applicable, see below |
| Connector container image | not applicable | GHCR digest |

Nothing here is signed. That is a deliberate statement of fact rather than an
omission, and it is a correction.

Releases up to and including **v0.0.19** carried an Authenticode signature on
the Windows MSI. Inspecting one shows why it was not worth having:

```
subject = CN = OpenPrintHQ
issuer  = CN = OpenPrintHQ
```

Subject and issuer are the same, which is to say the certificate vouches for
itself. It chains to no root any machine trusts, so Windows treats the installer
exactly as it treats an unsigned one, WDAC and AppLocker publisher rules cannot
match it, and some scanners score a signature that fails validation above one
that is absent. What it did produce reliably was a line in the build log, and a
line in `installer/README.md`, saying the installer was signed.

From the next release the MSI ships unsigned until a real certificate exists.
That is not a regression. It is the same amount of protection, stated
accurately, and the release job now refuses to publish an MSI carrying a
signature that does not verify, so this cannot quietly come back.

## How to verify a download today

Every release attaches the artifacts built from the tag in this repository, and
GitHub records which workflow run produced them. Until certificate signing is in
place, verification means comparing what you downloaded against what the release
publishes.

Windows:

```powershell
Get-FileHash .\OpenPrintHQ.Cloud.Client_0.0.19_x64_en-US.msi -Algorithm SHA256
```

macOS and Linux:

```sh
shasum -a 256 OpenPrintHQ-Cloud-Client-0.0.19-macos.pkg
```

Compare the result against the checksum published on the release page. If they
differ, do not install it, and open an issue.

The container image is addressed by digest, which is verification by
construction:

```sh
docker pull ghcr.io/norjms/openprinthq-connector@sha256:<digest>
```

## Where signing will come from

The build is already the shape a signing programme requires. Installers are
produced by GitHub Actions from a tag in a public repository, from source anyone
can read, with no local step in between. That is the property that lets a
certificate mean something: the signature attests to a binary that provably came
from the checked-in source.

Two routes are open, and the choice is recorded in the project notes rather than
here, because it involves money and identity documents rather than code.

**Azure Artifact Signing** (formerly Trusted Signing) issues short-lived
Microsoft-managed certificates, is open to self-employed individuals in the US,
Canada, EU and UK, costs about ten dollars a month, and carries Microsoft
reputation from the first signature, so SmartScreen does not have to be taught
who we are over thousands of downloads. It signs Windows artifacts only.

**SignPath Foundation** issues a free OV certificate to open source projects. The
Cloud Client meets the published criteria: AGPL-3.0-or-later with no commercial
dual licensing, actively maintained, already released, built by CI from source,
and owned by the team applying. It also signs Windows artifacts only, requires
multi-factor authentication on every account in the signing organisation, and
requires this document to exist, which is part of why it does.

macOS is separate from both. Notarization requires an Apple Developer ID at
ninety-nine dollars a year and no free programme substitutes for it. Until that
exists, macOS users will see Gatekeeper's warning, and macOS auto-update cannot
be enabled at all, because Gatekeeper will refuse a package installed without a
human present.

Linux packages will not be certificate-signed. The honest distribution mechanism
on Linux is a signed apt or yum repository, or the container image, and both are
better answers than teaching users to trust a downloaded `.deb`.

## Signing policy

The commitments below are what a certificate issued to this project would be
issued against.

- **What gets signed.** Release artifacts only, built by the `release` workflow
  in this repository from a version tag. Nothing signed by hand, nothing signed
  from a developer's machine, no exceptions for urgent fixes.
- **What the key can reach.** Signing credentials exist only as GitHub Actions
  secrets scoped to this repository, are never written to disk outside a runner's
  temporary directory, and are never present in a pull request build. A fork
  cannot obtain them, because Actions does not expose secrets to fork workflows.
- **Who can trigger a signature.** Only a repository maintainer, by dispatching
  the release workflow. Release runs are recorded in the Actions log and are
  public.
- **Who reviews.** James Norman is the project owner and sole maintainer, and is
  the Author, Reviewer and Approver for signing purposes. Where a signing
  programme requires those roles to be distinct, the project will say so rather
  than pretend otherwise.
- **Account security.** Multi-factor authentication is required on the GitHub
  account that holds the repository and on any signing service account.
- **Compromise.** If a signing credential is believed to be exposed, the
  credential is revoked before anything else, the affected releases are marked on
  the release page, and the incident is written up in the repository. Users are
  not asked to trust a rotated key silently.
- **Privacy.** Nothing about a user is sent anywhere as part of signing. Signing
  happens at build time, on our artifacts, before any user has the file.
- **Attribution.** Where a signing programme provides certificates without
  charge, this project will credit it here and in the release notes.

## Verifying once signing is in place

This section will state the certificate subject and thumbprint to expect, so
that "it is signed" can be checked against "it is signed by us". Until a
certificate is issued there is nothing truthful to put here, and a placeholder
would be worse than its absence.
