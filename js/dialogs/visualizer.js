let $visualizer = (function() {

    let processingInstance = null;



	function open_dialog(items, callback) {

        let filtered_items = [];
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                filtered_items.push(item);
            }
        }
        //console.log(filtered_items.length + ' filtered items');
        let data_streams = {};
        let keys = [];
        let has_data = false;
        for (let item of filtered_items) {
            for (let subitem of item.subitems) {
                if (subitem._include != 1) {
                    continue;
                }
                if (subitem._numeric_tags != undefined && subitem._numeric_tags.length > 0) {
                    console.log(JSON.stringify(subitem._numeric_tags));
                    for (let tag of subitem._numeric_tags) {
                        let parts = tag.split("=");
                        let name = parts[0];
                        let val = parts[1]
                        if (data_streams[name] == undefined) {
                            data_streams[name] = [];
                            has_data = true;
                            keys.push(name);
                        }
                        //new Date(newDate).getTime()
                        let date = new Date(item.timestamp);
                        date.setMilliseconds(0);
                        date.setSeconds(0);
                        date.setMinutes(0);
                        date.setHours(0);
                        let adjusted_timestamp = new Date(date).getTime();
                        console.log('adjusted timestamp = ' + adjusted_timestamp);
                        data_streams[name].push({"value":val, "timestamp":adjusted_timestamp});
                    }
                }
            }
        }

        if (has_data == false) {
            alert('No numeric data in view for visualization');
            callback();
            return;
        }

        function updateSelection(unit) {
            let max_timestamp = 0;
            let max_value = -10000000;
            for (let entry of data_streams[unit]) {
                max_timestamp = Math.max(max_timestamp, entry.timestamp);
                max_value = Math.max(max_value, entry.value);
            }
            let min_timestamp = max_timestamp;
            let min_value = max_value;
            for (let entry of data_streams[unit]) {
                min_timestamp = Math.min(min_timestamp, entry.timestamp);
                min_value = Math.min(min_value, entry.value);
            }

            data_streams[unit].sort(function(a, b) {
                return a.timestamp - b.timestamp;
            });

            for (let entry of data_streams[unit]) {
                console.log('\t'+JSON.stringify(entry));
            }

            function sketchProc(processing) {
               // Override draw function, by default it will be called 60 times per second

               processing.setup = function() {
                 processing.size(750, 250);
               }

               processing.draw = function() {

                processing.background(25);

                let x1 = 0;
                let x2 = 0;
                let y1 = 0;
                let y2 = 0;
                let W = processing.width;
                let H = processing.height;

                //TODO: maybe refactor these two parts into a single function
                for (let i = 0; i < data_streams[unit].length-1; i++) {
                    let a = data_streams[unit][i];
                    let b = data_streams[unit][i+1];
                    let xa_blend = (a.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                    let ya_blend = (a.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                    let xb_blend = (b.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                    let yb_blend = (b.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                    padW_left = 0;
                    padW_right = 25;
                    padH_top = 25;
                    padH_bottom = 3;
                    x1 = xa_blend*(W-padW_left-padW_right)+padW_left;
                    x2 = xb_blend*(W-padW_left-padW_right)+padW_left;
                    y1 = (1-ya_blend)*(H-padH_top-padH_bottom)+padH_top;
                    y2 = (1-yb_blend)*(H-padH_top-padH_bottom)+padH_top;

                    processing.stroke(75);
                    processing.strokeWeight(1.5);
                    processing.line(x1, y1, x1, H);
                    processing.line(x2, y2, x2, H);
                }

                for (let i = 0; i < data_streams[unit].length-1; i++) {
                    let a = data_streams[unit][i];
                    let b = data_streams[unit][i+1];
                    let xa_blend = (a.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                    let ya_blend = (a.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                    let xb_blend = (b.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                    let yb_blend = (b.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                    padW_left = 0;
                    padW_right = 25;
                    padH_top = 25;
                    padH_bottom = 3;
                    x1 = xa_blend*(W-padW_left-padW_right)+padW_left;
                    x2 = xb_blend*(W-padW_left-padW_right)+padW_left;
                    y1 = (1-ya_blend)*(H-padH_top-padH_bottom)+padH_top;
                    y2 = (1-yb_blend)*(H-padH_top-padH_bottom)+padH_top;

                    /*
                    processing.stroke(75);
                    processing.strokeWeight(1.5);
                    processing.line(x1, y1, x1, H);
                    processing.line(x2, y2, x2, H);
                    */

                    processing.stroke(0, 250, 0);
                    processing.strokeWeight(2);
                    processing.line(x1, y1, x2, y1);
                    processing.line(x2, y1, x2, y2);
                }
                processing.line(x2, y2, W, y2);
                this.noLoop();
               };
             }

            var canvas = document.getElementById("my-canvas");
            processingInstance = new Processing(canvas, sketchProc);
        }

        let options = '';
        for (let key of keys) {
            options += "<option value='"+key+"'>"+key+"</option>";
        }

        picoModal({
            content: 
                "<p style='font-weight:bold; margin:10px;'>Data Visualizer</p>" +
                "<div style='margin:10px;'>" +
                "<select id='sel_visualization_units'>" + options + "</select>" +
                "<br>" +
                "<br>" +
                "<canvas id='my-canvas'> </canvas>" +
                "<br>" +
                "<br>" +
                "<button class='ok'>Okay</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {

            $('#sel_visualization_units').on('change', function(e) {
                let unit = $(e.currentTarget).val();
                updateSelection(unit);
            });

            

            //TODO: render first


            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {

            let unit = $('#sel_visualization_units').val();
            updateSelection(unit);

        }).afterClose((modal, event) => {
            modal.destroy();
            callback();
        }).show();
	}

	return {
		open_dialog: open_dialog
	}
})();