import assert from 'node:assert/strict';
import test from 'node:test';

import { guessPastedFormat } from '../../app/static/js/modules/mode-manager/services/paste-format-guess-service.js';

function offered(text) {
    const guess = guessPastedFormat(text);
    if (guess === null) {
        return null;
    }
    return { kind: guess.kind, tags: guess.options.map((option) => option.tag) };
}

test('CSV-like text is offered as CSV; prose with commas is not', () => {
    assert.deepEqual(offered('name,age,city\nAda,36,London\nAlan,41,Wilmslow'), { kind: 'csv', tags: ['@csv'] });
    assert.deepEqual(offered('"Smith, John",42\n"Doe, Jane",37\n"Roe, Rick",29'), { kind: 'csv', tags: ['@csv'] });
    assert.equal(offered('a,b\nc,d'), null, 'two lines are too few');
    assert.equal(offered('I went home, then slept.\nShe called, but I missed it.\nWe met, and we talked.'), null);
    assert.equal(offered('a,b,c\nd,e\nf,g,h'), null, 'rows must have the same number of cells');
});

test('Markdown-like text needs two kinds of signs, or a table', () => {
    assert.deepEqual(offered('# Shopping\n\n- milk\n- eggs\n- bread'), { kind: 'markdown', tags: ['@markdown'] });
    assert.deepEqual(offered('Read the **docs** at [MetaList](https://example.com) first.'), { kind: 'markdown', tags: ['@markdown'] });
    assert.deepEqual(offered('| a | b |\n|---|---|\n| 1 | 2 |'), { kind: 'markdown', tags: ['@markdown'] });
    assert.deepEqual(offered('> A quote\n\nAnd `code` too'), { kind: 'markdown', tags: ['@markdown'] });
    assert.equal(offered('- milk\n- eggs\n- bread'), null, 'a lone bullet list is an ordinary note');
    assert.equal(offered('Just a sentence with **bold** in it.'), null);
    assert.equal(offered('A plain paragraph of text.\n\nAnother one.'), null);
});

const SNIPPETS = {
    '@code=sql': 'SELECT name, COUNT(*) AS notes\nFROM tags\nWHERE name LIKE \'py%\'\nGROUP BY name;',
    '@code=python': 'def greet(name):\n    # say hello\n    return f"Hello, {name}!" if name else None',
    '@code=ruby': '[1, 2, 3].each do |n|\n  puts "n = #{n}"\nend',
    '@code=javascript': 'const total = items.reduce((sum, item) => sum + item.price, 0);\nconsole.log(`Total: ${total}`);',
    '@code=typescript': 'interface User {\n  name: string;\n}\nconst greet = (user: User): string => `Hi ${user.name}`;',
    '@code=bash': '#!/bin/bash\nset -e\nfor f in *.txt; do\n  echo "$f"\ndone',
    '@code=html': '<!DOCTYPE html>\n<html>\n  <body><p class="x">Hi</p></body>\n</html>',
    '@code=xml': '<?xml version="1.0"?>\n<note>\n  <to>Tove</to>\n</note>',
    '@code=css': '.note {\n  color: red;\n  margin: 0 4px;\n}',
    '@code=java': 'public class Hello {\n    public static void main(String[] args) {\n        System.out.println("Hi");\n    }\n}',
    '@code=c': '#include <stdio.h>\nint main(void) {\n    printf("hi\\n");\n    return 0;\n}',
    '@code=cpp': '#include <iostream>\nint main() {\n    std::cout << "hi" << std::endl;\n}',
    '@code=csharp': 'using System;\nclass P {\n    static void Main() { Console.WriteLine("hi"); }\n}',
    '@code=go': 'package main\n\nimport "fmt"\n\nfunc main() {\n    x := 1\n    fmt.Println(x)\n}',
    '@code=rust': 'fn main() {\n    let mut count = 0;\n    println!("{}", count);\n}',
    '@code=yaml': 'name: metalist\nversion: 0.18.0\ndependencies:\n  - fastapi\n  - pygments',
    '@code=docker': 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nCMD ["python", "main.py"]',
};

for (const [tag, snippet] of Object.entries(SNIPPETS)) {
    test(`code is offered with ${tag} first`, () => {
        const guess = offered(snippet);
        assert.equal(guess?.kind, 'code', `not seen as code: ${JSON.stringify(snippet)}`);
        assert.equal(guess.tags[0], tag, `offered ${JSON.stringify(guess.tags)}`);
        assert(guess.tags.length <= 3);
    });
}

test('close languages are offered together, at most three', () => {
    // Plain JavaScript also reads as the start of TypeScript; without types JavaScript leads alone.
    assert.deepEqual(offered('const x = 1;\nlet y = x => x + 1;\nconsole.log(y(x));').tags, ['@code=javascript']);
    // Python and Ruby share `def`; a Ruby block with `end` keeps Ruby first.
    assert.equal(offered('def greet(name)\n  puts "Hi #{name}"\nend').tags[0], '@code=ruby');
});

test('prose, a single word and Markdown about code are not offered as code', () => {
    assert.equal(offered('Remember to call Mum about the weekend.'), null);
    assert.equal(offered('foo'), null);
    assert.equal(offered('# Install\n\nRun `npm install` and then:\n\n- start the server\n- open the page').kind, 'markdown');
});

test('ordinary notes that share a few signs with code are not offered', () => {
    assert.equal(offered('Meeting: Monday\nAgenda: budget\nAttendees: Bob, Ann'), null, 'key: value lines are not YAML');
    assert.equal(offered('Please select the best one from the list.'), null, 'a sentence is not SQL');
    assert.equal(offered('Call the plumber (again) tomorrow.\nBuy milk; eggs too.'), null);
});
