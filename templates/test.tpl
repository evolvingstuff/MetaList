<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
    <title>MetaList 2.0</title>
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <script src="/js/test.js"></script>
</head>
<body>
    %import json  # TODO: we don't want to import here
    %import time
    <h2>Items:</h2>
    %t1 = time.time()
    %for row in rows[:1000]:
        %node = json.loads(row['value'])
        %for subitem in node['subitems']:
            <div>{{! subitem['data'] }}</div>
        %end
        <hr>
        <br>
    %end
    %t2 = time.time()
    <div>render took {{ ((t2-t1)*1000) }} ms</div>
</body>
</html>