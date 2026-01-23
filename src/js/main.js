/**
 * Main JS - Lighthouse Design Build
 */

document.addEventListener('DOMContentLoaded', () => {
    console.log('Lighthouse Design Build - Website Loaded');

    initTheme();          // Call early to prevent flash
    initSmoothScroll();
    initFormEnhancements();
    initLazyLoading();
});

// Theme handling (light/dark mode with localStorage)

function getSystemPreference() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}

function setTheme(theme) {
    localStorage.setItem('theme', theme);

    if (theme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // Let Alpine components know theme changed
    window.dispatchEvent(new CustomEvent('theme-changed', {
        detail: { theme, isDark: theme === 'dark' }
    }));
}

function toggleTheme() {
    const currentTheme = localStorage.getItem('theme') || getSystemPreference();
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
}

function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const theme = savedTheme || getSystemPreference();

    if (theme === 'dark') {
        document.documentElement.classList.add('dark');
    }

    // Watch for system theme changes (only applies if user hasn't picked one)
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!localStorage.getItem('theme')) {
                setTheme(e.matches ? 'dark' : 'light');
            }
        });
    }
}

function getCurrentTheme() {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

// Smooth scrolling for anchor links
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            if (href === '#') return;

            e.preventDefault();

            const targetId = href.substring(1);
            const targetElement = document.getElementById(targetId);

            if (targetElement) {
                const navHeight = document.getElementById('main-navigation')?.offsetHeight || 80;
                const targetPosition = targetElement.offsetTop - navHeight - 20;

                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
}

// Form styling on focus/blur
function initFormEnhancements() {
    const inputs = document.querySelectorAll('input, textarea, select');

    inputs.forEach(input => {
        input.addEventListener('focus', () => {
            input.classList.add('ring-2', 'ring-lighthouse-teal');
        });

        input.addEventListener('blur', () => {
            input.classList.remove('ring-2', 'ring-lighthouse-teal');
        });

        input.addEventListener('invalid', (e) => {
            e.preventDefault();
            input.classList.add('border-red-500', 'ring-red-200');
        });

        input.addEventListener('input', () => {
            if (input.validity.valid) {
                input.classList.remove('border-red-500', 'ring-red-200');
                input.classList.add('border-green-500');
            }
        });
    });
}

// Lazy load images using IntersectionObserver
function initLazyLoading() {
    const images = document.querySelectorAll('img[loading="lazy"]');

    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                    }
                    img.classList.add('loaded');
                    observer.unobserve(img);
                }
            });
        }, { rootMargin: '50px' });

        images.forEach(img => imageObserver.observe(img));
    }
}

// Page loader - hides the loading overlay
function hideLoader() {
    const loader = document.getElementById('page-loader');
    if (loader) {
        loader.classList.add('fade-out');
        setTimeout(() => loader.remove(), 500);
    }
}

window.hideLoader = hideLoader;

// Auto-hide unless page has data-manual-loader (those pages call hideLoader themselves)
window.addEventListener('load', () => {
    if (!document.body.hasAttribute('data-manual-loader')) {
        hideLoader();
    }
});

// Utility functions
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// Exported for use elsewhere
window.LighthouseUtils = {
    debounce,
    throttle,
    toggleTheme,
    setTheme,
    getCurrentTheme,
    getSystemPreference
};
