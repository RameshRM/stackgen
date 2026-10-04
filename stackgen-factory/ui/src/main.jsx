import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

document.body.style.margin = '0';

/**
 * No StrictMode.
 *
 * It runs every effect twice in development to expose code that assumes one
 * run. That is a good thing to be told, and this sign-in is built on values
 * that are deliberately single use — a state, an authorization code, one
 * redirect. Each double invocation consumed the first value and then failed on
 * the second, reporting that the sign-in was never started.
 *
 * The guards it prompted are still in `auth.js` and are worth keeping: they are
 * what makes a double-clicked sign-in or a re-rendered callback harmless. What
 * is not worth keeping is a development wrapper that breaks the first screen
 * anyone sees.
 */
ReactDOM.createRoot(document.getElementById('root')).render(
    <BrowserRouter>
        <App />
    </BrowserRouter>,
);
