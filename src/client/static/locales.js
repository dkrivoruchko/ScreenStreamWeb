export class Locales {
    selectedLocale;
    #defaultLocale = 'en';
    #translations = {};
    #defaultTranslations = {};

    constructor(supportedTags, browserLanguages) {
        this.selectedLocale = this.#lookup(supportedTags, browserLanguages);
    }

    async fetchTranslation() {
        try {
            const response = await fetch(`/lang/${this.selectedLocale}.json`);
            this.#translations = await response.json();
        } catch (error) {
            window.DD_LOGS && DD_LOGS.logger.error(`Locales: fetchTranslation for ${this.selectedLocale} failed: ${error.message}`, { error });
        }

        if (this.selectedLocale != this.#defaultLocale) {
            try {
                const response = await fetch(`/lang/${this.#defaultLocale}.json`);
                this.#defaultTranslations = await response.json();
            } catch (error) {
                window.DD_LOGS && DD_LOGS.logger.error(`Locales: fetchDefaultTranslation for ${this.#defaultLocale} failed: ${error.message}`, { error });
            }
        }
    }

    getTranslationByKey(key) {
        return this.#translations[key] || this.#defaultTranslations[key];
    }

    translateDocument() {
        document.querySelectorAll('[data-i18n-key]').forEach((element) => {
            const value = this.getTranslationByKey(element.getAttribute('data-i18n-key'));
            if (value) element.innerHTML = value;
        });
    }

    #lookup(tags, right) {
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
        return this.#defaultLocale;
    }
}