import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Primer CSS (https://primer.style/css): design tokens, light/dark themes
// (selected by data-color-mode on <html>), then the component modules we use.
import '@primer/css/dist/primitives.css';
import '@primer/primitives/dist/css/functional/size/radius.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '@primer/css/dist/base.css';
import '@primer/css/dist/buttons.css';
import '@primer/css/dist/forms.css';
import '@primer/css/dist/utilities.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
