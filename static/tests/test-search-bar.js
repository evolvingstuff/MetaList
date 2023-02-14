let assertEqual = unit.assertEqual;
let assertTrue = unit.assertTrue;


unit.test({
    "parse empty search strings":
    {
        "empty string is a valid query and returns empty parse results": () => {
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
            assertTrue(_.isEqual(emptyParsedSearch, parseSearch(emptySearchString)));
        },
        "empty string with spaces is a valid query and returns empty parse results": () => {
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
            assertTrue(_.isEqual(emptyParsedSearch, parseSearch(emptySearchStringWithSpaces)));
        }
    },

    // "subtract()": {
    //     "5 - 5 should equal 0": () => {
    //         assertEqual(0, subtract(5, 5));
    //     },
    // },
    // "multiply()":
    // {
    //     "3 * 5 should equal 15": () => {
    //         assertEqual(15, multiply(3, 5));
    //     },
    // },
    //
    // "divide()": {
    //     "49 / 7 should equal 7": () => {
    //         assertEqual(7, divide(49, 7));
    //     },
    //     "9 / 9 should equal 1": () => {
    //         // Another erroneous expected value
    //         assertEqual(0, divide(9, 9));
    //     },
    // }
});