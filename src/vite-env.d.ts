/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_MATRIX_HOMESERVER_URL?: string
  readonly VITE_AUTH_ISSUER?: string
  readonly VITE_AUTH_CLIENT_ID?: string
  readonly VITE_AUTH_REDIRECT_URI?: string
  readonly VITE_ENABLE_DEV_LOGIN?: string
  readonly VITE_ENABLE_PHONE_MATRIX_LOGIN?: string
  readonly VITE_ENABLE_MATRIX_SSO?: string
  readonly VITE_ENABLE_DEMO_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
