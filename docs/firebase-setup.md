# Firebase setup for push notifications

The server side of push is built (FCM HTTP v1, `packages/providers/src/fcm.ts`). It switches on as
soon as a Firebase service-account key is configured. Until then push is off and documents still
finish normally (the app sees the result through SSE or by reloading).

## 1. Create the project (Firebase console, about 5 minutes)

1. Open https://console.firebase.google.com and sign in with the account that should own the project.
2. **Add project**, name it e.g. `bd-lawassist` (or `bd-lawassist-dev` for development; use separate
   projects for dev and production). Google Analytics is not needed.
3. In the project: **Build > Cloud Messaging**. The "Firebase Cloud Messaging API (V1)" must show as
   enabled (it is by default for new projects). The legacy API is not used.

## 2. Server key (for the worker)

1. **Project settings (gear icon) > Service accounts > Firebase Admin SDK > Generate new private key.**
2. A JSON file downloads. **It is a secret.** Do not commit it, paste it into chat or send it by email.
3. Development: put it at `secrets/firebase-service-account.json` (git ignores `secrets/` and any
   `*firebase-adminsdk*.json`) and set in `.env`:
   ```
   FCM_SERVICE_ACCOUNT_FILE=secrets/firebase-service-account.json
   ```
4. Staging / production: store the JSON in AWS Secrets Manager and inject it as
   `FCM_SERVICE_ACCOUNT_JSON` (the whole JSON as one value).
5. Restart the worker. Its startup log shows `push notifications` with `pushEnabled: true`.

The key only needs to send messages. If you create a dedicated service account instead of the
default Admin SDK one, give it the role **Firebase Cloud Messaging API Admin** only.

## 3. App registration (for the Flutter app, MOB-07)

1. **Project settings > General > Your apps**: add an **Android** app (package name, e.g.
   `bd.lawassist.app`) and an **iOS** app (bundle id).
2. Android: download `google-services.json` into `apps/mobile/android/app/`.
   iOS: download `GoogleService-Info.plist`, and under **Cloud Messaging > Apple app configuration**
   upload an APNs authentication key (.p8) from the Apple Developer account.
   These two files identify the app; they are not server secrets, but keep them out of public repos.
3. In the app, after sign-in and on every token refresh:
   `POST /api/v1/me/devices {"token": "<FCM token>", "platform": "ANDROID" | "IOS"}`.
   On sign-out: `DELETE /api/v1/me/devices {"token": "<FCM token>"}`.

## What a push contains

A generic title and body in the user's language ("Analysis ready" / "বিশ্লেষণ প্রস্তুত") and data
`{type: "DOCUMENT_FINISHED", artifact_id, status}`. No names, sections or document text are sent to
Google. The app opens the document by its id and loads the details over the API.
