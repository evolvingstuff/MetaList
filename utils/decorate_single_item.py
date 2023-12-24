import re
import json
import hashlib
import nltk
from nltk.corpus import stopwords
from config.config import inherit_text
from utils.search_filters import filter_subitem_negative, filter_subitem_positive
from utils.generate import generate_timestamp


re_searchable_text = re.compile('<.*?>|&([a-z0-9]+|#[0-9]{1,6}|#x[0-9a-f]{1,6});')
special_char = '^'
punctuation_to_remove = "!\"#$%&'()*+,./;<=>?@[\\]_`{|}~"
re_remove_punctuation = re.compile(rf'[{re.escape(punctuation_to_remove)}]')
re_remove_hyphen_colon = re.compile(r'(?<!\S)[\-\:]|[\-\:](?!\S)')

re_remove_breaks = re.compile(r'<br\s*/?>')
re_remove_divs = re.compile(r'</?(div|p)\b[^>]*>')

date_patterns = [
    r'\b\d{1,2}/\d{1,2}/\d{2,4}\b',    # Matches MM/DD/YYYY
    r'\b\d{1,2}-\d{1,2}-\d{2,4}\b',    # Matches MM-DD-YYYY
    r'\b\d{1,2}\.\d{1,2}\.\d{2,4}\b',  # Matches MM.DD.YYYY
    r'\b\d{2,4}/\d{1,2}/\d{1,2}\b',    # Matches YYYY/MM/DD
    r'\b\d{2,4}-\d{1,2}-\d{1,2}\b',    # Matches YYYY-MM-DD
    r'\b\d{2,4}\.\d{1,2}\.\d{1,2}\b',  # Matches YYYY.MM.DD
    r'\b\d{1,2}/\d{1,2}/\d{2,4}\b',    # Matches DD/MM/YYYY
    r'\b\d{1,2}-\d{1,2}-\d{2,4}\b',    # Matches DD-MM-YYYY
    r'\b\d{1,2}\.\d{1,2}\.\d{2,4}\b',  # Matches DD.MM.YYYY
    r'\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s\d{1,2},\s\d{4}\b', # Matches Month DD, YYYY
    r'\b\d{1,2}\s(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s\d{4}\b', # Matches DD Month YYYY
]
re_date = re.compile('|'.join(date_patterns))

days_of_week_pattern = r'\b(Mon(day)?|Tue(s(day)?)?|Wed(nesday|s)?|Thu(r(s(day)?)?)?|Fri(day)?|Sat(urday)?|Sun(day)?)\b'
re_days_of_week = re.compile(days_of_week_pattern, re.IGNORECASE)

url_pattern = r'https?://\S+|www\.\S+'
re_url = re.compile(url_pattern, re.IGNORECASE)

phone_pattern = r'\b(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?[\d]{3}[-.\s]?[\d]{4,6}\b'
re_phone = re.compile(phone_pattern)

integer_pattern = r'(?<![\w.%#!@_])-?\d+\b(?![\w.%#!@_])'
re_integer = re.compile(integer_pattern)

ip_pattern = r'\b(?:\d{1,3}\.){3}\d{1,3}\b'
re_ip = re.compile(ip_pattern)

float_pattern = r'(?<!\w)-?\d+\.\d+(?!\w)'
re_float = re.compile(float_pattern)

email_pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b'
re_email = re.compile(email_pattern, re.IGNORECASE)

time_pattern = r'\b((1[0-2]|0?[1-9]):[0-5][0-9](\s?[APMapm]{2})?|([01]?[0-9]|2[0-3]):[0-5][0-9])\b'
re_time = re.compile(time_pattern, re.IGNORECASE)

ordinal_pattern = r'\b\d+(?:st|nd|rd|th)\b'
re_ordinal = re.compile(ordinal_pattern)

month_pattern = r'\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b'
re_month = re.compile(month_pattern, re.IGNORECASE)

exponential_pattern = r'\b([a-zA-Z]|\d+(\.\d+)?)\^(\-?\d+(\.\d+)?|[a-zA-Z])\b'
re_exponential = re.compile(exponential_pattern)

money_pattern = r'(?<!\w)\$\d+(?:\.\d{1,2})?(?=\W|$)'
re_money = re.compile(money_pattern)

nltk.download('stopwords')
nltk.download('punkt')
stop_words = set(stopwords.words('english'))


def clean_tags(tag_string):
    cleaned = tag_string.strip() + ' '
    while '  ' in cleaned:
        cleaned = cleaned.replace('  ', ' ')
    return cleaned


def hash_dictionary(d):
    serialized = json.dumps(d, sort_keys=True)
    hash_object = hashlib.sha256(serialized.encode())
    hash_hex = hash_object.hexdigest()
    return hash_hex


def hash_dictionary_fast(d):
    serialized = json.dumps(d, sort_keys=True)
    return hash(serialized)


def get_searchable_text(text):
    newline = ' '  # /n
    text = re.sub(re_remove_breaks, newline, text)
    text = re.sub(re_remove_divs, newline, text)
    return re_searchable_text.sub('', text).lower().strip()


def get_keyword_text(text):
    filtered_text = text
    filtered_text = re.sub(re_money, f'{special_char}money{special_char}', filtered_text)
    filtered_text = re.sub(re_exponential, f'{special_char}exp{special_char}', filtered_text)
    filtered_text = re.sub(re_date, f'{special_char}date{special_char}', filtered_text)
    # filtered_text = re.sub(re_month, f'{special_char}month{special_char}', filtered_text)
    filtered_text = re.sub(re_days_of_week, f'{special_char}dow{special_char}', filtered_text)
    filtered_text = re.sub(re_time, f'{special_char}time{special_char}', filtered_text)
    filtered_text = re.sub(re_url, f'{special_char}url{special_char}', filtered_text)
    # filtered_text = re.sub(re_phone, f'{special_char}phone{special_char}', filtered_text)  # TODO fix
    filtered_text = re.sub(re_ip, f'{special_char}ip{special_char}', filtered_text)
    filtered_text = re.sub(re_email, f'{special_char}email{special_char}', filtered_text)
    filtered_text = re.sub(re_ordinal, f'{special_char}ord{special_char}', filtered_text)
    filtered_text = re.sub(re_float, f'{special_char}float{special_char}', filtered_text)
    filtered_text = re.sub(re_integer, f'{special_char}int{special_char}', filtered_text)
    filtered_text = re_remove_punctuation.sub(' ', filtered_text)
    filtered_text = re_remove_hyphen_colon.sub(' ', filtered_text)
    word_tokens = filtered_text.split()
    filtered_text = ' '.join([word for word in word_tokens if word not in stop_words])
    return filtered_text


def decorate_item(item):
    parent_stack = []
    rank = 0  # TODO BUG this does not increase, so all items are 0)
    # TODO recalculate char_count
    item['last_edit'] = generate_timestamp()

    # remove these so as not to include them in _hash
    if '_dirty_matches' in item:
        del item['_dirty_matches']
    if '_hash_matches' in item:
        del item['_hash_matches']

    item_tags = set()

    for subitem in item['subitems']:

        # remove search match decorations before hash
        if '_neg_match' in subitem:
            del subitem['_neg_match']
        if '_match' in subitem:
            del subitem['_match']

        subitem['_searchable_text'] = get_searchable_text(subitem['data'])
        subitem['char_count'] = len(subitem['_searchable_text'])
        keyword_text = get_keyword_text(subitem['_searchable_text'])
        subitem['_searchable_text_full'] = subitem['_searchable_text']

        subitem['tags'] = clean_tags(subitem['tags'])  # TODO: this messes up things when editing tags
        subitem['_tags'] = [t for t in subitem['tags'].split() if t]
        item_tags.update(subitem['_tags'])

        # TODO this is probably not efficient
        subitem['_keyword_text'] = keyword_text
        subitem['_keyword_text_full'] = subitem['_keyword_text']
        if len(parent_stack) > 0:  # TODO: probably inefficient
            while parent_stack[-1]['indent'] >= subitem['indent']:
                parent_stack.pop()
            if len(parent_stack) > 0:
                assert int(parent_stack[-1]['indent']) == int(subitem['indent']) - 1
                if '@list-bulleted' in parent_stack[-1]['_tags']:
                    subitem['_@list-bulleted'] = True
                if '@list-numbered' in parent_stack[-1]['_tags']:
                    subitem['_@list-numbered'] = rank
            for parent in parent_stack:
                non_special_parent_tags = [t for t in parent['_tags'] if not t.startswith('@')]
                for tag in non_special_parent_tags:
                    if tag not in subitem['_tags']:
                        subitem['_tags'].append(tag)
                if inherit_text:
                    subitem['_searchable_text_full'] += ' ' + parent['_searchable_text']
                    subitem['_keyword_text_full'] += ' ' + parent['_keyword_text']

        parent_stack.append(subitem)

        tags_str = ' '.join([f'#{t}' for t in subitem['_tags'] if t and not t.startswith('@')])
        if tags_str != '':
            subitem['_keyword_text_full'] = subitem['_keyword_text_full'] + ' ' + tags_str

    item['_tags'] = list(item_tags)

    # TODO: why is this needed?
    for subitem in item['subitems']:
        tags_str = ' '.join([f'#{t}' for t in subitem['tags'].split() if t and not t.startswith('@')])
        if tags_str != '':
            subitem['_keyword_text'] = subitem['_keyword_text'] + ' ' + tags_str

    if '_hash' in item:
        del item['_hash']  # don't hash the hash
    item['_hash'] = hash_dictionary(item)
    item['_dirty_matches'] = True  # add back in after, so we don't rerun filters on everything
    return item


def filter_item_and_decorate_subitem_matches(item, search_filter):
    """
    This could technically be included in utils.search_filter, but
    since it has the possibility of mutating the decorated state of the item,
    it is more appropriate to be in here.
    """
    # if no search filter, EVERYTHING matches
    if len(search_filter['tags']) == 0 and \
            len(search_filter['texts']) == 0 and \
            search_filter['partial_text'] is None and \
            search_filter['partial_tag'] is None and \
            len(search_filter['negated_tags']) == 0 and \
            len(search_filter['negated_texts']) == 0 and \
            search_filter['negated_partial_text'] is None and \
            search_filter['negated_partial_tag'] is None:
        for subitem in item['subitems']:
            if '_neg_match' in subitem:
                del subitem['_neg_match']
            subitem['_match'] = True
        return True

    for tag in search_filter['tags']:
        if tag not in item['_tags']:
            item['subitems'][0]['_neg_match'] = True
            return False

    at_least_one_match = False
    for subitem in item['subitems']:
        if '_match' in subitem:
            del subitem['_match']
        if '_neg_match' in subitem:
            del subitem['_neg_match']
        if filter_subitem_negative(subitem, search_filter):
            subitem['_neg_match'] = True
        elif filter_subitem_positive(subitem, search_filter):
            subitem['_match'] = True
            at_least_one_match = True
    if not at_least_one_match:
        return False
    propagate_match_decorations(item)
    if '_match' not in item['subitems'][0]:
        return False
    return True


def propagate_match_decorations(item):
    # TODO this could be more efficient (use a stack)
    """
    Stages:
    1) propagate blocks to children
    2) propagate matches to parents
    3) propagate matches to children
    """
    blocked_indices = set()
    for i, subitem in enumerate(item['subitems']):
        if '_neg_match' in subitem:
            # 1) propagate blocks to children
            for j in range(i+1, len(item['subitems'])):
                subitem2 = item['subitems'][j]
                if subitem2['indent'] > subitem['indent']:
                    blocked_indices.add(j)
                else:
                    break
    for i in blocked_indices:
        if '_match' in item['subitems'][i]:
            del item['subitems'][i]['_match']
        item['subitems'][i]['_neg_match'] = True

    matched_indices = set()
    for i, subitem in enumerate(item['subitems']):
        if '_match' in subitem:
            indent_cursor = subitem['indent']
            # 2) propagate matches to parents
            for j in range(i-1, -1, -1):
                parent_subitem = item['subitems'][j]
                if parent_subitem['indent'] < indent_cursor:
                    if '_neg_match' in parent_subitem:
                        break
                    matched_indices.add(j)
                    indent_cursor = parent_subitem['indent']
            # 3) propagate matches to children
            for j in range(i+1, len(item['subitems'])):
                child_subitem = item['subitems'][j]
                if '_neg_match' in child_subitem:
                    break
                if child_subitem['indent'] > subitem['indent']:
                    matched_indices.add(j)
                else:
                    break
    for i in matched_indices:
        item['subitems'][i]['_match'] = True
