export class SitrepButton {
  private container: HTMLElement;

  constructor(parentId: string) {
    const parent = document.getElementById(parentId);
    if (!parent) return;

    this.container = document.createElement('div');
    this.container.className = 'grid48-sitrep-btn';
    this.container.style.cssText = `
      position: absolute;
      bottom: 20px;
      left: 20px;
      z-index: 1000;
    `;
    
    const btn = document.createElement('button');
    btn.innerText = 'SITREP TÁTICO';
    btn.style.cssText = `
      background: rgba(255, 0, 0, 0.8);
      color: #fff;
      border: 2px solid #ff0000;
      padding: 12px 24px;
      border-radius: 4px;
      font-weight: bold;
      cursor: pointer;
      font-family: monospace;
      text-transform: uppercase;
      box-shadow: 0 0 15px rgba(255,0,0,0.5);
      transition: all 0.3s ease;
      backdrop-filter: blur(4px);
    `;

    btn.onmouseover = () => {
      btn.style.background = '#ff0000';
      btn.style.boxShadow = '0 0 25px rgba(255,0,0,0.8)';
    };
    
    btn.onmouseout = () => {
      btn.style.background = 'rgba(255, 0, 0, 0.8)';
      btn.style.boxShadow = '0 0 15px rgba(255,0,0,0.5)';
    };

    btn.onclick = () => {
      btn.innerText = 'PROCESSANDO IA...';
      btn.style.background = '#ccaa00';
      btn.style.borderColor = '#ffee00';
      btn.style.boxShadow = '0 0 20px rgba(255,255,0,0.5)';
      
      // Simula um pedido de SITREP que foi para a nuvem e voltou com a resposta do Gemini
      setTimeout(() => {
        btn.innerText = 'RISCO NÍVEL 8 - ENERGIA';
        btn.style.background = '#880000';
        btn.style.borderColor = '#ff0000';
        
        setTimeout(() => {
          btn.innerText = 'SITREP TÁTICO';
          btn.style.background = 'rgba(255, 0, 0, 0.8)';
          btn.style.borderColor = '#ff0000';
          btn.style.boxShadow = '0 0 15px rgba(255,0,0,0.5)';
        }, 8000);
      }, 3000);
    };

    this.container.appendChild(btn);
    parent.appendChild(this.container);
  }

  public mount() {
    // Already mounted in constructor
  }
}
