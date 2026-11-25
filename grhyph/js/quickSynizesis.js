const synizesisVowelsRe = new RegExp('^([αάa][ηhιϊi]|[εe][ϊ]|[εe][ιi](?:[αάaοόoωώw]|[οo][υύuy])|[ιi](?:[αάaεέeοόoωώw]|[αa][ιίi]|[οo][ιίiυύuy])|[οόo](?:[ιiϊ]|[εe][ιi])|[οo][ιίi](?:[αάaεέeοόoωώw]|[οo][ιίiυύuy])|[υuy][αάaιiοόoωώw])$', 'i');

const speechSoundRe = /([ϊϋΐΰ]|[αa][ύυuy]|[εe][ύυuy]|[ηi][ύυuy]|[αa][ίιi]|[εe][ίιi]|[οo][ύυuy]|[οo][ίιi]|[άαa]|[έεe]|[ήηi]|[ίιi]|[όοo]|[ύυyu]|[ώωwo])|((?:[μm][πp]|b)|(?:[γg][κk]|[γg])|[νn][τtj]|[νn]|(?:[τt]h+|[θ8])|(?:[δd])|(?:[τtj][ζz]|j)|[ζz]|[τtj][σsc]|[σsc][τtj]|[βv]|[λl]|[μm]|(?:ks|κs|kσ|[ξx3])|[ρr]|[τt]|[φf]|[χx]|ch|(?:[pπ][σsc]|[ψ4])|[πp]|[σsc]|[κkq])|([\s\.,\-–—―\/'’":!?;&@«»])|(.)/gi;

// A direct port of Go's WordStartConsonantsRe.
const wordStartConsonantsReStr = "^([βvb](?:[τt]h|[δdγgλlρr])|[γg](?:[τt]h|[δdκkqλlνnρr])|(?:[τt]h|[δd])[νn]|(?:[τt]h|[δd])[ρr]|(?:[τt]h|[θ8])[λlνnρr]|[κkq][βvb]|[κkq][λlνnρrj]|[κkq][τt]$|[μm][νnπp]|[νn][τtj][^h]|[πp][λlνnρrτtj]|[πp][φf]|[σsc](?:[τt](?:[^hθ8βvbγgκkqμmνnπpφfχx]|h)|[θ8βvbγgκkqλlμmπpφfχxh])|[σsc][νn]|[τt](?:[μm]$|[ζzρrσsc])|[φf](?:[τt]h?|[θ8λlρrχxh]|ch)|[φf][κkq]|(?:[χxh]|ch)(?:[θ8λlνnρr]|[τt]h?))";

const wscReCache = new Map();

// A direct port of Go's GetWSCRe.
const getWSCRe = (options) => {
    const key = JSON.stringify(options);
    if (wscReCache.has(key)) {
        return wscReCache.get(key);
    }

    let reStr = wordStartConsonantsReStr;
    if (!options.combineConsonantsDn) reStr = reStr.replace("|(?:[τt]h|[δd])[νn]", "");
    if (!options.combineConsonantsKv) reStr = reStr.replace("|[κkq][βvb]", "");
    if (!options.combineConsonantsPf) reStr = reStr.replace("|[πp][φf]", "");
    if (!options.combineConsonantsSn) reStr = reStr.replace("|[σsc][νn]", "");
    if (!options.combineConsonantsFk) reStr = reStr.replace("|[φf][κkq]", "");

    const compiledRe = new RegExp(reStr, 'i');
    wscReCache.set(key, compiledRe);
    return compiledRe;
};

const stringToSpeechSounds = (word) => {
    const matches = [...word.matchAll(speechSoundRe)];
    const speechSounds = [];
    let eventualVowelsExist = false;
    let immediateConsonants = 0;

    for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        let group = 'other';
        if (match[1]) group = 'vowels';
        else if (match[2]) group = 'consonants';
        else if (match[3]) group = 'punctuation';

        const nextSound = speechSounds[0];
        const immediateVowelExists = nextSound ? nextSound.group === 'vowels' : false;

        const ss = {
            match: match[0],
            group,
            eventualVowelsExist,
            immediateVowelExists,
            immediateConsonants,
        };
        speechSounds.unshift(ss);

        if (group === 'vowels') {
            eventualVowelsExist = true;
            immediateConsonants = 0;
        } else if (group === 'consonants') {
            immediateConsonants++;
        } else {
            eventualVowelsExist = false;
            immediateConsonants = 0;
        }
    }
    return speechSounds;
};

// A direct port of Go's consonantHyphenation function.
const consonantHyphenation = (speechSounds, startIndex, consonantsN, wscRe, separator) => {
    let hyphenatedConsonants = '';
    const endIndex = startIndex + consonantsN;

    for (let i = startIndex; i < endIndex; i++) {
        if (i === endIndex - 1) {
            hyphenatedConsonants += separator + speechSounds[i].match;
            break;
        }

        const consonantsPair = speechSounds[i].match + speechSounds[i + 1].match;
        if (wscRe.test(consonantsPair)) {
            hyphenatedConsonants += separator;
            for (let j = i; j < endIndex; j++) {
                hyphenatedConsonants += speechSounds[j].match;
            }
            i = endIndex; // End the outer loop
            break;
        } else {
            hyphenatedConsonants += speechSounds[i].match;
            // The separator will be added by the next iteration's check
        }
    }
    return hyphenatedConsonants;
};

export const hyphenate = (word, { quickSynizesis = false, separator = '\u00AD' } = {}) => {
    const options = {
        combineConsonantsDn: false,
        combineConsonantsKv: false,
        combineConsonantsPf: false,
        combineConsonantsSn: false,
        combineConsonantsFk: true, // Default from Go code
    };
    const wscRe = getWSCRe(options);
    const speechSounds = stringToSpeechSounds(word);

    if (speechSounds.length < 2) {
        return word;
    }

    let hyphenated = '';
    for (let i = 0; i < speechSounds.length; i++) {
        const ss = speechSounds[i];

        if (ss.group === 'consonants' && ss.immediateVowelExists) {
            hyphenated += ss.match;
            continue;
        }

        if (ss.group === 'vowels') {
            if (ss.eventualVowelsExist && ss.immediateConsonants === 1) {
                hyphenated += ss.match + separator;
                continue;
            }
            if (ss.immediateConsonants >= 1 && !ss.eventualVowelsExist) {
                hyphenated += ss.match;
                continue;
            }
            if (ss.eventualVowelsExist && ss.immediateConsonants > 1) {
                const hyphenatedConsonants = consonantHyphenation(speechSounds, i + 1, ss.immediateConsonants, wscRe, separator);
                hyphenated += ss.match + hyphenatedConsonants;
                i += ss.immediateConsonants;
                continue;
            }
            if (ss.immediateVowelExists) {
                if (quickSynizesis && synizesisVowelsRe.test(ss.match + speechSounds[i + 1].match)) {
                    hyphenated += ss.match;
                } else {
                    hyphenated += ss.match + separator;
                }
                continue;
            }
        }

        hyphenated += ss.match;
    }

    if (hyphenated.endsWith(separator)) {
        hyphenated = hyphenated.slice(0, -1);
    }

    return hyphenated;
};
