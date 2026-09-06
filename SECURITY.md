# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository owner through a private security-reporting channel offered by the hosting platform. If no private channel is available, ask the owner for one without disclosing exploit details publicly.

Include:

- affected version or commit;
- minimal reproduction using synthetic, redacted input;
- expected and observed behavior;
- impact and prerequisite conditions; and
- relevant local commands and downstream dependency versions.

Do **not** include API keys, environment files, access tokens, private prompts, provider responses, unredacted logs, real faces, songs, or other personal/source media. Revoke exposed credentials with the provider rather than sending them to maintainers. Do not test against systems or accounts you do not own or have permission to assess, and do not trigger paid or external calls merely to demonstrate a report.

Maintainers will acknowledge reports when available, investigate, and coordinate an appropriate disclosure. No fixed response or remediation deadline is guaranteed.

## Scope and safe operation

The CLI processes sensitive local configuration and may eventually send selected inputs to third-party providers. Environment files, generated artifacts, checkpoints, source media, project overrides, and exports should remain untracked. Review provider policies, retention, access, model-training terms, region, and cost before use. Unknown cost is not zero.

Use only likenesses, music, logos, and other material for which you have rights and informed consent. Identity and likeness checks are probabilistic and cannot establish consent, ownership, or a perfect identity match. See [docs/privacy.md](docs/privacy.md) for data-flow and deletion limits.

Project code and documentation are licensed under the [MIT License](LICENSE). That
license does not grant rights to likenesses, music, input assets, generated media, or
third-party services; the safeguards in this policy still apply.
