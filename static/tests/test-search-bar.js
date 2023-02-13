let assertEqual = unit.assertEqual;


unit.test({
    "sum()":
    {
        "1 + 2 should equal 3": () => {
            assertEqual(4, dumbAdd(1, 2));
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