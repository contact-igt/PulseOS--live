# Client logos

Approved client marks live here as `/brand/<name>.svg|png|webp` and are referenced from a hospital's sign-in configuration
(`tenant_login_configs.logo_path`). Only files in this folder can be used (the database refuses any other path or an outside URL).

* Use the client's APPROVED file exactly as supplied: never stretch, recolour, redraw or generate a client mark.
* No approved logo? Leave `logo_path` empty: the sign-in page shows the typographic name (the fallback) and nothing is blocked.
* `test-mark.svg` is a neutral PulseOS-made placeholder used ONLY by tests; it is not a client's mark.
