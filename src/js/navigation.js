/**
 * Navigation - mobile menu, scroll effects, active link highlighting
 */

function navigationComponent() {
    return {
        open: false,
        scrolled: false,
        activeSection: '',
        scrollThreshold: 100,
        scrollListenerActive: false,

        init() {
            this.onScroll();
            if (!this.scrollListenerActive) {
                this.setupScrollListener();
            }
            this.highlightActiveLink();
        },

        toggleMenu() {
            this.open = !this.open;
            document.body.style.overflow = this.open ? 'hidden' : 'auto';
        },

        closeMenu() {
            this.open = false;
            document.body.style.overflow = 'auto';
        },

        onScroll() {
            const scrollTop = window.scrollY || window.pageYOffset;
            this.scrolled = scrollTop > this.scrollThreshold;
        },

        setupScrollListener() {
            let ticking = false;
            this.scrollListenerActive = true;

            window.addEventListener('scroll', () => {
                if (!ticking) {
                    window.requestAnimationFrame(() => {
                        this.onScroll();
                        ticking = false;
                    });
                    ticking = true;
                }
            }, { passive: true });
        },

        highlightActiveLink() {
            const currentPath = window.location.pathname;
            const navLinks = document.querySelectorAll('.nav-link');

            navLinks.forEach(link => {
                try {
                    if (link.href) {
                        const linkPath = new URL(link.href).pathname;
                        if (linkPath === currentPath) {
                            link.classList.add('text-lighthouse-teal', 'font-bold');
                        } else {
                            link.classList.remove('text-lighthouse-teal', 'font-bold');
                        }
                    }
                } catch (e) {
                    // Skip invalid URLs
                }
            });
        },

        handleEscape(event) {
            if (event.key === 'Escape' && this.open) {
                this.closeMenu();
            }
        }
    };
}

// Escape key closes menu
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const navElement = document.getElementById('main-navigation');
        if (navElement && navElement.__x && navElement.__x.$data) {
            navElement.__x.$data.handleEscape(e);
        }
    }
});

// Highlight current page link on load
document.addEventListener('DOMContentLoaded', () => {
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('.nav-link');

    navLinks.forEach(link => {
        try {
            if (link.href) {
                const linkPath = new URL(link.href).pathname;
                if (linkPath === currentPath) {
                    link.classList.add('text-lighthouse-teal');
                }
            }
        } catch (e) {}
    });
});
