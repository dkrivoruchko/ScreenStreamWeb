export function Locales(supportedTags, browserLanguages) {
    this.selectedLocale = this.lookup(supportedTags, browserLanguages);
    this.defaultLocale = 'en';
    this.translations = {};
    this.defaultTranslations = {};
}
Locales.prototype.fetchTranslation = function () {
    return new Promise((resolve, reject) => {
        fetch(`/lang/${this.selectedLocale}.json`)
            .then(response => response.json())
            .then(translations => {
                this.translations = translations;
                if (this.selectedLocale === this.defaultLocale) {
                    resolve();
                    return;
                }

                fetch(`/lang/${this.defaultLocale}.json`)
                    .then(response => response.json())
                    .then(defaultTranslations => {
                        this.defaultTranslations = defaultTranslations;
                        resolve();
                    })
                    .catch(error => {
                        window.DD_LOGS && DD_LOGS.logger.warn(`Locales: fetchDefaultTranslation for ${this.defaultLocale} failed: ${error.message}`, { error });
                        reject(error);
                    });
            })
            .catch(error => {
                window.DD_LOGS && DD_LOGS.logger.warn(`Locales: fetchTranslation for ${this.selectedLocale} failed: ${error.message}`, { error });
                reject(error);
            });
    });
};
Locales.prototype.getTranslationByKey = function (key) {
    return this.translations[key] || this.defaultTranslations[key];
}
Locales.prototype.translateDocument = function () {
    document.querySelectorAll('[data-i18n-key]').forEach((element) => {
        const value = this.getTranslationByKey(element.getAttribute('data-i18n-key'));
        if (value) element.innerHTML = value;
    });
};
Locales.prototype.lookup = function (tags, right) {
    const check = function (tag, range) {
        let right = range
        while (true) {
            if (right === '*' || tag === right) return true
            let index = right.lastIndexOf('-')
            if (index < 0) return false
            if (right.charAt(index - 2) === '-') index -= 2
            right = right.slice(0, index)
        }
    }

    let left = tags;
    let rightIndex = -1

    while (++rightIndex < right.length) {
        const range = right[rightIndex].toLowerCase();

        let leftIndex = -1;
        const next = [];

        while (++leftIndex < left.length) {
            if (check(left[leftIndex].toLowerCase(), range)) {
                return left[leftIndex];
            } else {
                next.push(left[leftIndex]);
            }
        }
        left = next;
    }
    return this.defaultLocale;
};