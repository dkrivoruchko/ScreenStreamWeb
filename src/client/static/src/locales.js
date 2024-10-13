function log(level, message, context = {}) {
    if (window.DD_LOGS && DD_LOGS.logger) {
        DD_LOGS.logger[level](message, context);
    } else {
        console[level](message, context);
    }
}

export class Locales {
    constructor(supportedTags, browserLanguages) {
        this.defaultLocale = 'en';
        this.selectedLocale = this.lookup(supportedTags, browserLanguages).toLowerCase();
        this.translations = {};
        this.defaultTranslations = {};
    }

    async fetchTranslation() {
        try {
            const response = await fetch(`/lang/${this.selectedLocale}.json`);
            if (!response.ok) {
                throw new Error(`Failed to fetch translations for locale '${this.selectedLocale}'.`);
            }
            this.translations = await response.json();

            if (this.selectedLocale !== this.defaultLocale) {
                const defaultResponse = await fetch(`/lang/${this.defaultLocale}.json`);
                if (!defaultResponse.ok) {
                    throw new Error(`Failed to fetch default translations for locale '${this.defaultLocale}'.`);
                }
                this.defaultTranslations = await defaultResponse.json();
            }
        } catch (error) {
            log('warn', `Locales: fetchTranslation failed: ${error.message}`, { error });
            throw error;
        }
    }

    getTranslationByKey(key) {
        return this.translations[key] || this.defaultTranslations[key];
    }

    translateDocument() {
        document.querySelectorAll('[data-i18n-key]').forEach((element) => {
            const key = element.getAttribute('data-i18n-key');
            const value = this.getTranslationByKey(key);
            if (value) {
                element.innerHTML = value;
            } else {
                log('warn', `Translation missing for key: '${key}'`);
            }
        });
    }

    lookup(tags, ranges) {
        const checkTagInRange = function (tag, range) {
            let currentRange = range;

            while (currentRange) {
                if (currentRange === '*' || tag === currentRange) return true;
                const index = currentRange.lastIndexOf('-');
                if (index < 0) return false;
                currentRange = currentRange.slice(0, currentRange.charAt(index - 2) === '-' ? index - 2 : index);
            }
        };

        let remainingTags = tags;

        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i].toLowerCase();
            const nextTags = [];

            for (let j = 0; j < remainingTags.length; j++) {
                const tag = remainingTags[j].toLowerCase();
                if (checkTagInRange(tag, range)) {
                    return remainingTags[j];
                } else {
                    nextTags.push(remainingTags[j]);
                }
            }
            remainingTags = nextTags;
        }

        return this.defaultLocale;
    }
}