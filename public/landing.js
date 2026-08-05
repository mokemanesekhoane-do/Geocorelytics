(() => {
  // Scroll-reveal for below-the-fold sections.
  const targets = document.querySelectorAll(
    '.lp-section .lp-reveal, .lp-platform .lp-reveal, .lp-trust-band .lp-reveal, .lp-about .lp-reveal, .lp-cta-band .lp-reveal'
  );
  if ('IntersectionObserver' in window && targets.length) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('lp-in-view');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    targets.forEach((el) => observer.observe(el));
  } else {
    targets.forEach((el) => el.classList.add('lp-in-view'));
  }

  // Nav: solid/blurred state once the page has scrolled past the hero top.
  const nav = document.getElementById('lp-nav');
  if (nav) {
    const updateNavState = () => {
      nav.classList.toggle('lp-scrolled', window.scrollY > 30);
    };
    updateNavState();
    window.addEventListener('scroll', updateNavState, { passive: true });
  }

  // Mobile hamburger menu.
  const hamburger = document.getElementById('lp-hamburger');
  const mobileMenu = document.getElementById('lp-mobile-menu');
  if (hamburger && mobileMenu) {
    const closeMenu = () => {
      hamburger.classList.remove('lp-open');
      mobileMenu.classList.remove('lp-open');
      hamburger.setAttribute('aria-expanded', 'false');
    };
    const toggleMenu = () => {
      const isOpen = hamburger.classList.toggle('lp-open');
      mobileMenu.classList.toggle('lp-open', isOpen);
      hamburger.setAttribute('aria-expanded', String(isOpen));
    };
    hamburger.addEventListener('click', toggleMenu);
    mobileMenu.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }
})();
