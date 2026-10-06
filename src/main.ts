import { add } from './lib/example';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app not found');

app.innerHTML = `
  <header>
    <a href="https://mustafaobaidd1.github.io/">Portfolio</a>
    <a href="https://github.com/mustafaobaidd1/monochord-string-lab">Source</a>
  </header>
  <main>
    <h1>Monochord — the physics of a vibrating string</h1>
    <p>2 + 3 = ${add(2, 3)}</p>
  </main>
`;

document.documentElement.dataset.ready = 'true';
