# Connect Google Ads to a PulseOS tenant

This guide covers live campaign, spend, and performance reporting. The November 20–21, 2026 setup confirmed Google Ads API Explorer access and OAuth token generation for the Cloud operator. That operator had no Ads account access, and the advertiser login hit a passkey challenge. A successful live tenant sync was not observed.

## 1. Check access before creating credentials

| Sign in to | Use |
| --- | --- |
| PulseOS | A user who can manage integrations for the intended tenant. Confirm the tenant name before saving. |
| Google Cloud Console | A project operator who can manage the API and OAuth client. In our setup this was the Labs account. |
| Google Ads and the OAuth consent screen | A Google user who can open the target advertiser's **Campaigns** page. In our setup this was the Ads login. |

Open [Google Ads](https://ads.google.com/) as the intended OAuth user and select the existing advertiser. Click the profile picture to find its 10-digit **Customer ID**. Record it without dashes. If access is through a manager account, record the manager's ID separately. [Google's Customer ID guide](https://support.google.com/google-ads/answer/1704344)

If Google Ads says the Cloud operator has no Ads accounts, have an advertiser admin invite that operator under **Admin → Access and security → + → Read-only** for reporting. Accept the invitation and verify the Campaigns page. An existing valid refresh token for that user and OAuth client can then be tried. Creating a new Ads account will not grant access to the existing campaigns. [Google's access guide](https://support.google.com/google-ads/answer/6372672)

## 2. Set up the Google Cloud project

1. In the Cloud Console, select the integration's project. Our project was `igt-pulseos-ads-prod-261120` (**PulseOS Google Ads**).
2. Enable **Google Ads API**, click **Manage**, and check **Current access level**. For live reporting, apply for **Explorer** if the project shows **Test**. The project above already showed **Explorer**. [Google Ads API access](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
3. Open **Google Auth Platform → Clients**. Use an existing **Desktop** OAuth client from this project or create one. Save its downloaded JSON privately outside the repository. If the app is **External → Testing**, add the intended OAuth user under **Audience → Test users**. External testing refresh tokens for the Ads scope expire after seven days, so account for this before relying on unattended production sync. [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

The tenant connector uses its own OAuth credentials. Cloud CLI login and the local Application Default Credentials (ADC) quota project are optional for this flow.

## 3. Generate the refresh token on Windows

1. Verify Python in a fresh PowerShell window. If the launcher reports no installed Python, install the runtime and reopen PowerShell.

   ```powershell
   winget install --id Python.Python.3.13 --exact --scope user
   py -3.13 --version
   ```

2. Once the version prints, install the library and open the script in Notepad.

   ```powershell
   py -3.13 -m pip install --user google-auth-oauthlib
   notepad "$env:USERPROFILE\get_ads_refresh_token.py"
   ```

3. Paste the following into **Notepad**, adjust the filename if your download has a different name, and save with **Ctrl+S**.

   ```python
   from pathlib import Path
   from google_auth_oauthlib.flow import InstalledAppFlow

   client_file = Path.home() / "Downloads" / "credentials.json"
   flow = InstalledAppFlow.from_client_secrets_file(
       str(client_file),
       scopes=["https://www.googleapis.com/auth/adwords"],
   )
   credentials = flow.run_local_server(port=0, prompt="consent")
   if not credentials.refresh_token:
       raise SystemExit("Google did not return a refresh token.")
   print("Refresh token:", credentials.refresh_token)
   ```

4. Run the script in **PowerShell**. Leave it open and use the browser on the same computer so the local callback can reach it. Choose the user whose Ads access you verified and approve consent. Store the returned token securely. [Google's credential sample](https://developers.google.com/google-ads/api/samples/generate-user-credentials)

   ```powershell
   py -3.13 "$env:USERPROFILE\get_ads_refresh_token.py"
   ```

## 4. Configure and verify the PulseOS tenant

1. Open **Integrations → Google Ads → Configuration**. Enter the advertiser's **Customer ID** and, if applicable, the **Manager account ID**. Save.
2. In **Credentials**, enter the value of `client_id` as the **OAuth client ID**, `client_secret` as the **OAuth client secret**, and the script output as the **Refresh token**. Keep the OAuth values from the same client. Select **Live** and save. **Fixture** uses sample data without contacting Google.
3. Review **Health → Check Status Now**, then open **Sync → Sync now**. Review **Activity** for the sync result and compare campaign and spend data with the same advertiser and date range in Google Ads. Count the connection as verified only after a successful live sync.

### Developer token field in the current PulseOS release

Google retired developer tokens for the Google Ads API and now manages access on the Cloud project that owns the OAuth client. The current PulseOS [integration catalogue](../apps/api/src/domain/integration/hub-catalogue.ts) and [live reporting adapter](../apps/api/src/domain/ads/google-ads.ts) still require the field. An existing team-owned legacy token may be available to a manager-account admin in [Google Ads API Center](https://ads.google.com/aw/apicenter). Google ignores the legacy header for this API. If the team has no legacy token, live onboarding needs a deployed PulseOS update that makes the field optional in both readiness validation and the live adapter. Leave the field empty until that release is available. [Google's migration guide](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Google OAuth keeps returning to a passkey error | Use the device holding the passkey, or use [Google Account Recovery](https://accounts.google.com/signin/recovery) from a familiar device. If another Ads admin can open the advertiser, invite the working OAuth user as described in step 1. |
| Consent shows access denied before token generation | Verify the chosen Google user is allowed by the OAuth app's Audience settings. With External Testing, check the test-user list. |
| Browser opens an old OAuth URL or localhost fails | Restart the script for a fresh URL. Leave the current script running and complete consent on the same computer. |
| `No installed Python found` or `Python was not found` | Install the runtime and verify it with `py -3.13 --version` in fresh PowerShell. |
| PowerShell says `Missing argument in parameter list` after pasting Python | Save Python code in the Notepad script. Run only the PowerShell command in the terminal. |
| `FileNotFoundError: client_secret.json` | The running script still points to the old name. Save the corrected script and verify the downloaded file is at `$env:USERPROFILE\Downloads\credentials.json` with `Test-Path "$env:USERPROFILE\Downloads\credentials.json"`. |
| pip reports that helper scripts are missing from PATH | If installation ended with `Successfully installed`, use the `py -3.13` command shown above. |
| `gcloud projects list` says there is no active account | If using the optional CLI, run `gcloud auth list`. Select a saved account with `gcloud config set account ACCOUNT`, or run `gcloud auth login` if none is saved. The row marked `*` is active. |
| `gcloud config set project` reports an ADC quota mismatch | `Updated property [core/project]` confirms the CLI project change. If a separate local tool needs ADC, verify the target project number before using `gcloud auth application-default set-quota-project PROJECT_ID`. In our setup, `1034299898753` matched the intended project. The ADC update succeeded after Cloud Resource Manager API was enabled. The ADC identity also needs `serviceusage.services.use`. [Google ADC reference](https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/set-quota-project) |
| Live sync gives a Google access error | Verify the OAuth user can open the exact advertiser, the Customer ID is correct, and the manager ID is supplied when using manager access. Confirm Explorer or higher on the project that owns the OAuth client. |
| A secret was exposed in an IDE selection, screenshot, or chat | Rotate or replace the exposed credential, update PulseOS with the replacement, and revoke any exposed refresh token. Keep credential JSON and tokens out of the repository and support messages. |
