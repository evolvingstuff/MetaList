let assertEqual = unit.assertEqual;
let assertTrue = unit.assertTrue;


unit.test({
    "parse empty search strings":
    {
        "empty string is a valid query and returns empty parse results": () => {
            let searchBar = new SearchBar();
            let emptySearchString = '';
            let emptyParsedSearch = {
                tags: [],
                negated_tags: [],
                texts: [],
                negated_texts: [],
                partial_tag: null,
                negated_partial_tag: null,
                partial_text: null,
                negated_partial_text: null
            }
            assertTrue(_.isEqual(emptyParsedSearch, searchBar.parseSearch(emptySearchString)));
        },
        "empty string with spaces is a valid query and returns empty parse results": () => {
            let searchBar = new SearchBar();
            let emptySearchStringWithSpaces = '  ';
            let emptyParsedSearch = {
                tags: [],
                negated_tags: [],
                texts: [],
                negated_texts: [],
                partial_tag: null,
                negated_partial_tag: null,
                partial_text: null,
                negated_partial_text: null
            }
            assertTrue(_.isEqual(emptyParsedSearch, searchBar.parseSearch(emptySearchStringWithSpaces)));
        }
    },
    "parse search strings starting with /":
    {
        "should recognize / as a valid first character of partial tag": () => {
            let searchBar = new SearchBar();
            let searchString = '/';
            let parsedSearch = {
                tags: [],
                negated_tags: [],
                texts: [],
                negated_texts: [],
                partial_tag: '/',
                negated_partial_tag: null,
                partial_text: null,
                negated_partial_text: null
            }
            assertTrue(_.isEqual(parsedSearch, searchBar.parseSearch(searchString)));
        },
        "should recognize / as a valid standalone tag": () => {
            let searchBar = new SearchBar();
            let searchString = '/ ';
            let parsedSearch = {
                tags: ['/'],
                negated_tags: [],
                texts: [],
                negated_texts: [],
                partial_tag: null,
                negated_partial_tag: null,
                partial_text: null,
                negated_partial_text: null
            }
            assertTrue(_.isEqual(parsedSearch, searchBar.parseSearch(searchString)));
        }
    },
});