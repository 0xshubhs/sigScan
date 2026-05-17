import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBus } from './bus';

const bus = createBus();
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App bus={bus} />);
}
