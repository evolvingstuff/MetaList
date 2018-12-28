let $visualize_categorical = (function() {

    let processingInstance = null;

	function open_dialog(items, callback) {
        let filtered_items = [];
        for (let item of items) {
            if (item.subitems[0]._include == 1) {
                filtered_items.push(item);
            }
        }
        let data_streams = {};
        let keys = [];
        let has_data = false;
        let max_timestamp = 0;
        let min_timestamp = 1000000000000000;
        for (let item of filtered_items) {
            for (let subitem of item.subitems) {
                if (subitem._include != 1) {
                    continue;
                }
                for (let tag of subitem._direct_tags.concat(subitem._implied_tags)) {
                    if (tag.startsWith('@') || tag.startsWith('#')) {
                        continue;
                    }
                    if (data_streams[tag] == undefined) {
                        data_streams[tag] = [];
                        has_data = true;
                        keys.push({"name":tag, "count":0});
                    }
                    let date = new Date(item.timestamp);
                    date.setMilliseconds(0);
                    date.setSeconds(0);
                    date.setMinutes(0);
                    date.setHours(0);
                    let adjusted_timestamp = new Date(date).getTime();
                    data_streams[tag].push(adjusted_timestamp);
                    max_timestamp = Math.max(max_timestamp, adjusted_timestamp);
                    min_timestamp = Math.min(min_timestamp, adjusted_timestamp);
                    keys.filter(key => key.name == tag)[0].count += 1;
                }
            }
        }

        max_timestamp += 86400000; //add width of a day to the end

        if (has_data == false) {
            alert('No data in view for visualization');
            callback();
            return;
        }

        function updateSelection(unit) {
            data_streams[unit].sort(function(a, b) {
                return a - b;
            });

            function sketchProc(processing) {

               processing.setup = function() {
                 processing.size(750, 100);
               }

               processing.draw = function() {

                processing.background(25);

                let x1 = 0;
                let x2 = 0;
                let y1 = 0;
                let y2 = 0;
                let W = processing.width;
                let H = processing.height;
                let xa_blend = 0;
                let xb_blend = 0;

                //TODO: maybe refactor these two parts into a single function
                for (let i = 0; i < data_streams[unit].length; i++) {
                    let a = data_streams[unit][i];
                    let b = a + 86400000;
                    if (max_timestamp == min_timestamp) {
                        xa_blend = 0;
                        xb_blend = 1;
                    }
                    else {
                         xa_blend = (a - min_timestamp) / (max_timestamp - min_timestamp);
                         xb_blend = (b - min_timestamp) / (max_timestamp - min_timestamp);
                    }
                    padW_left = 0;
                    padW_right = 0;
                    x1 = xa_blend*(W-padW_left-padW_right)+padW_left;
                    x2 = xb_blend*(W-padW_left-padW_right)+padW_left;
                    processing.noStroke();
                    processing.fill(0, 255, 0, 115); //115
                    processing.rect(x1, 0, (x2-x1), H);
                }
                this.noLoop();
               };
             }
            var canvas = document.getElementById("canvas-categorical");
            processingInstance = new Processing(canvas, sketchProc);
        }

        let options = '';
        for (let key of keys.sort((a, b) => b.count - a.count)) {
            options += "<option value='"+key.name+"'>"+key.name+" ("+key.count+")</option>";
        }

        picoModal({
            content: 
                "<p style='font-weight:bold; margin:10px;'>Categorical Data Visualizer</p>" +
                "<div style='margin:10px;'>" +
                "<select id='sel_visualization_units'>" + options + "</select>" +
                "<br>" +
                "<br>" +
                "<canvas id='canvas-categorical'> </canvas>" +
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