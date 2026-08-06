import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles.css'

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() { void updateSW(true) },
  onRegisteredSW(_url, registration) {
    window.setInterval(() => { void registration?.update() }, 5 * 60 * 1000)
  },
})

createRoot(document.getElementById('root')!).render(
  <App />,
)
