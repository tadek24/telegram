export const authConfig = {
  homeserverUrl: import.meta.env.VITE_MATRIX_HOMESERVER_URL?.trim() ?? '',
  issuer: import.meta.env.VITE_AUTH_ISSUER?.trim() ?? '',
  clientId: import.meta.env.VITE_AUTH_CLIENT_ID?.trim() ?? '',
  redirectUri: import.meta.env.VITE_AUTH_REDIRECT_URI?.trim() ?? '',
  matrixSsoEnabled: import.meta.env.VITE_ENABLE_MATRIX_SSO === 'true',
  phoneMatrixLoginEnabled: import.meta.env.VITE_ENABLE_PHONE_MATRIX_LOGIN === 'true',
  devLoginEnabled: import.meta.env.VITE_ENABLE_DEV_LOGIN === 'true',
  demoModeEnabled: import.meta.env.VITE_ENABLE_DEMO_MODE !== 'false',
}

export function getProductionConfigError() {
  if (authConfig.phoneMatrixLoginEnabled) {
    if (!authConfig.homeserverUrl) return 'Logowanie jest obecnie konfigurowane'
    try {
      const url = new URL(authConfig.homeserverUrl)
      const local = ['localhost', '127.0.0.1'].includes(url.hostname)
      if (url.protocol !== 'https:' && !local) return 'Logowanie jest obecnie konfigurowane'
    } catch { return 'Logowanie jest obecnie konfigurowane' }
    return null
  }
  if (authConfig.matrixSsoEnabled) {
    if (!authConfig.homeserverUrl) return 'Logowanie jest obecnie konfigurowane'
    try {
      if (new URL(authConfig.homeserverUrl).protocol !== 'https:') return 'Logowanie jest obecnie konfigurowane'
    } catch { return 'Logowanie jest obecnie konfigurowane' }
    return null
  }
  if (!authConfig.homeserverUrl || !authConfig.issuer || !authConfig.clientId || !authConfig.redirectUri) {
    return 'Logowanie jest obecnie konfigurowane'
  }
  try {
    const values = [authConfig.homeserverUrl, authConfig.issuer, authConfig.redirectUri]
    if (values.some(value => new URL(value).protocol !== 'https:')) return 'Logowanie jest obecnie konfigurowane'
  } catch { return 'Logowanie jest obecnie konfigurowane' }
  return null
}
