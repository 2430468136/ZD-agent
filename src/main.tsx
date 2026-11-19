import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import LocalWorkbench from './LocalWorkbench'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocalWorkbench />
  </StrictMode>,
)
