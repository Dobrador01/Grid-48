// Grid 48 tem uma única variante ('full'). SITE_VARIANT é mantido como
// string pra retro-compat com callers que ainda recebem/comparam o valor.
// O override VITE_VARIANT existe só pra testes locais.
export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return import.meta.env.VITE_VARIANT || 'full';
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') {
    return import.meta.env.VITE_VARIANT || 'full';
  }
  return 'full';
})();
