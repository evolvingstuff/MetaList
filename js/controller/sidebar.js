let $sidebar = (function() {

	/* This is currently a little broken */
	let SHOW_SIMILAR_ENTRIES = false; //TODO: turn this on when we have better notions of similarity

	function updateSidebar(items, item, subitem, mode_editing) {
		/*
		if (item == null) {
			return;
		}
		*/
		mode_editing = true;


		html = '';

		html += '<table id="tbl-advanced"><tr>';

		if (mode_editing) {
			html += '<td id="sidebar-editor-column" valign="top">';
			html += '<div style="color:white; font-weight:bold; padding-top:0px; margin-bottom:0px; font-size:large;">EDITOR</div>';

			html += '<hr>';

			let color = '';
			if (subitem != null && 
				(subitem._direct_tags.includes('@todo') || 
				 subitem._implied_tags.includes('@todo'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Toggle @todo" class="btn btn-default btn-sm action-toggle-todo">';
            html += '    <span class="glyphicon glyphicon-ok"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@todo</span>';
            html += '</div>';


            if (subitem != null && 
            	(subitem._direct_tags.includes('@list-bulleted') || 
            	 subitem._implied_tags.includes('@list-bulleted'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Toggle @list-bulleted" class="btn btn-default btn-sm action-toggle-list-bulleted">';
            html += '    <span class="glyphicon glyphicon-list"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@list-bulleted</span>';
            html += '</div>';

            if (subitem != null && 
            	(subitem._direct_tags.includes('@list-numbered') || 
            	 subitem._implied_tags.includes('@list-numbered'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Toggle @list-numbered" class="btn btn-default btn-sm action-toggle-list-numbered">';
            html += '    <span class="glyphicon glyphicon-list-alt"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@list-numbered</span>';
            html += '</div>';


            if (subitem != null &&
            	(subitem._direct_tags.includes('@code') || 
            	 subitem._implied_tags.includes('@code'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Toggle @code" class="btn btn-default btn-sm action-toggle-code">';
            html += '    <span class="glyphicon glyphicon-console"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@code</span>';
            html += '</div>';

            if (subitem != null && 
            	(subitem._direct_tags.includes('@bold') || 
            	 subitem._implied_tags.includes('@bold'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Toggle @bold" class="btn btn-default btn-sm action-toggle-bold">';
            html += '    <span class="glyphicon glyphicon-bold"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@bold</span>';
            html += '</div>';

            if (subitem != null && 
            	(subitem._direct_tags.includes('@italic') || 
            	 subitem._implied_tags.includes('@italic'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Toggle @italic" class="btn btn-default btn-sm action-toggle-italic">';
            html += '    <span class="glyphicon glyphicon-italic"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@italic</span>';
            html += '</div>';

            for (let i = 1; i <= 4; i++) {

            	if (subitem != null && 
            		(subitem._direct_tags.includes('@h'+i) || 
	            	 subitem._implied_tags.includes('@h'+i))) {
					color = 'white';
				}
				else {
					color = 'black';
				}

	            html += '<div style="margin:10px;">';
				html += '  <button type="button" title="Toggle @h'+i+'" class="btn btn-default btn-sm action-toggle-h'+i+'">';
	            html += '    h'+i;
	            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@h'+i+'</span>';
	            html += '</div>';
        	}

        	if (subitem != null && 
        		(subitem._direct_tags.includes('@embed') || 
            	 subitem._implied_tags.includes('@embed'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Create link to this item in clipboard\n(ctrl-shift-L)" class="btn btn-default btn-sm action-make-link">';
            html += '    <span class="glyphicon glyphicon-link"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@embed</span>';
            html += '</div>';

            if (subitem != null && 
            	(subitem._direct_tags.includes('@copy') || 
            	 subitem._implied_tags.includes('@copy'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Copy subsection to clipboard\n(ctrl-shift-C)" class="btn btn-default btn-sm action-copy-subsection">';
            html += '    <span class="glyphicon glyphicon-copy"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@copy</span>';
            html += '</div>';

            if (subitem != null && 
            	(subitem._direct_tags.includes('@paste') || 
            	 subitem._implied_tags.includes('@paste'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Paste from clipboard\n(ctrl-shift-V)" class="btn btn-default btn-sm action-paste-subsection">';
            html += '    <span class="glyphicon glyphicon-paste"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@paste</span>';
            html += '</div>';

            if (subitem != null && 
            	(subitem._direct_tags.includes('@date-headline') || 
            	 subitem._implied_tags.includes('@date-headline'))) {
				color = 'white';
			}
			else {
				color = 'black';
			}

            html += '<div style="margin:10px;">';
			html += '  <button type="button" title="Toggle @date-headline" class="btn btn-default btn-sm action-toggle-date-headline">';
            html += '    <span class="glyphicon glyphicon-calendar"></span>';
            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">@date-headline</span>';
            html += '</div>';

            let date_value = '';
            if (item != null) {
            	date_value = formatDate(item);
            }

            html += '<div style="margin:10px;">';
            html += '  <input style="width:135px;" type="date" class="time action-edit-time" size="5" value="' + date_value + '"></input>';
            html += '</div>';

            

			html += '</td>';
		}

		html += '<td id="sidebar-tags-column" valign="top" >';

		html += '<div style="color:white; font-weight:bold; padding-top:0px; margin-bottom:5px; font-size:large;">TAGS</div>';

		html += '<hr>';

		if (item != null) {
			let all_tags = [];
			let above_tags = [];
			let numeric_tag_parts = [];

			if (subitem._numeric_tags != undefined && subitem._numeric_tags.length > 0) {
				for (let tag of subitem._numeric_tags) {
					all_tags.push(tag);
					numeric_tag_parts.push(tag.split('=')[0]);
				}
			}

			if (subitem._direct_tags != undefined && subitem._direct_tags.length > 0) {
				for (let tag of subitem._direct_tags) {
					if (numeric_tag_parts.includes(tag) == false) {
						all_tags.push(tag);
					}
				}
			}

			if (subitem._inherited_tags != undefined && subitem._inherited_tags.length > 0) {
				for (let tag of subitem._inherited_tags) {
					above_tags.push(tag);
				}
			}

			let all_shown = [];
			let imps = $ontology.getImplications();

			function tagDisplay(tags) {
				for (let tag of tags) {
					html += '<div style="padding-top:5px; padding-left:12px; color:white;">';
					if (all_shown.includes(tag) == false) {
						html += formatSomeTags(tag);
						all_shown.push(tag);
						if (imps[tag] != undefined) {
							for (let imp of imps[tag]) {
								if (imp != tag) {
									html += '<div style="margin-left:35px; color:white;">';
									html += imp;
									html += '</div>';
									all_shown.push(imp);
								}
							}
						}
					}
					html += '</div>';
				}
			}

			if (above_tags.length > 0) {
				tagDisplay(above_tags);
			}

			tagDisplay(all_tags);

			html += '</td>';

			if (SHOW_SIMILAR_ENTRIES) {

				html += '<td valign="top">';

				html += '<div style="color:white; font-weight:bold; padding-top:0px; font-size:large;">Similar Entries</div>';

				let tot = 0;

				let start = Date.now();

				let match_groups = {};

				all_tags = subitem._tags.concat(subitem._implied_tags).concat(subitem._inherited_tags);

				let tiers = [];

				let MINIMUM_MATCHES = 1;

				for (let other_item of items) {

					if (other_item.deleted != undefined) {
						continue;
					}
					if (other_item.id == item.id) {
						continue;
					}

					
					if (other_item.subitems[0]._include != 1) {
						continue;
					}
					

					for (let i = 0; i < other_item.subitems.length; i++) {
						let other_subitem = other_item.subitems[i];
						
						//TODO: handle private stuff better

						
						if (other_subitem._include != 1) {
							continue;
						}
						
						
						let matches = 0;
						let other_all_tags = other_subitem._tags.concat(other_subitem._implied_tags).concat(other_subitem._inherited_tags);
						//let other_all_tags = other_subitem._direct_tags;

						let matched = [];

						for (let tag of all_tags) {
							if (other_all_tags.includes(tag)) {
								if (matched.includes(tag) == false) {
									matched.push(tag);
								}
							}
						}
						tot += 1;

						if (matched.length == 0) {
							continue;
						}
						if (match_groups[matched.length] == undefined) {
							match_groups[matched.length] = [];
							tiers.push(matched.length);
						}
						match_groups[matched.length].push(
							{
								other_item:other_item, 
								other_subitem:other_subitem, 
								subitem_index:i, 
								matched: matched
							});
					}
				}
				let end = Date.now();

				tiers.sort().reverse();

				let MAX_RESULTS = 100;
				let results = [];

				for (let tier of tiers) {
					if (tier < MINIMUM_MATCHES) {
						break;
					}
					let match_group = match_groups[tier];
					match_group.sort(
						function(a, b) {
							return a.other_item.priority - b.other_item.priority;
						});
					let highest = 0;
					for (let entry of match_group) {
						if (entry.other_item.priority < highest) {
							console.log('\tSORTING ERROR');
						}
						highest = entry.other_item.priority;
						if (results.length >= MAX_RESULTS) {
							break;
						}
						results.push(entry);
					}
					if (results.length >= MAX_RESULTS) {
						break;
					}
				}

				let count = 0;

				for (let entry of results) {
					let text = $format.parse(entry.other_subitem.data, entry.other_subitem._direct_tags, entry.other_item, entry.other_subitem, entry.subitem_index);
					if (text.trim() != '') {
						let extra = '';
						if (count%2==0) {
							extra='background-color:#dddddd;'
						}
						html += '<div style="padding-left:2px; padding-top:4px; padding-bottom:4px; '+extra+' width:500px;overflow-wrap: break-word;">'+text+'</div>';
						
						html += '<hr style="color:white;">';

						count++;
					}
				}

				html += "</td>";
			}
		}

		html += "</tr></table>";

		$('#div_side_panel').html(html);
	}

	function clearSidebar(filtered_items) {
		// html = '';
		// html += '<table id="tbl-advanced"><tr>';
		// html += '<td id="sidebar-tags-column" valign="top">';
		// html += '<div style="color:white; font-weight:bold; padding-top:0px; font-size:large;">TAGS</div>';
		// html += "</tr></table>";
		// $('#div_side_panel').html(html);
		updateSidebar(filtered_items, null, null, false);
	}

	function formatSomeTags(tag) {
		if (tag == '@bold') {
			tag = '<span style="font-weight:bold;">'+tag+'</span>';
		}
		if (tag == '@italics') {
			tag = '<span style="font-style:italics;">'+tag+'</span>';
		}
		if (tag == '@green') {
			tag = '<span style="color:green;">'+tag+'</span>';
		}
		if (tag == '@blue') {
			tag = '<span style="color:blue;">'+tag+'</span>';
		}
		if (tag == '@red') {
			tag = '<span style="color:red;">'+tag+'</span>';
		}
		if (tag == '@grey') {
			tag = '<span style="color:grey;">'+tag+'</span>';
		}
		/*
		if (tag == '@h1') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h2') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h3') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h4') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@meta') {
			tag = '<span class="badge badge-light">'+tag+'</span>';
		}
		if (tag == '@macro') {
			tag = '<span class="badge badge-primary" style="background-color:green;">'+tag+'</span>';
		}
		*/
		
		if (tag == '@todo') {
			tag = '<span><i class="glyphicon glyphicon-unchecked"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@done') {
			tag = '<span><i class="glyphicon glyphicon-check"></i>&nbsp;'+tag+'</span>';
		}
		/*
		if (tag == '@goto') {
			tag = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span">'+tag+'</span>';
		}
		*/
		/*
		if (tag == '@code') {
			tag = '<span class="copyable"><code>'+tag+'</code></span>';
		}
		*/
		if (tag == '@-') {
			tag = '<span><i class="glyphicon glyphicon-menu-up"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@+') {
			tag = '<span><i class="glyphicon glyphicon-menu-down"></i>&nbsp;'+tag+'</span>';
		}
		
		/*
		if (tag == '@date-headline') {
			tag = '<span class="glyphicon glyphicon-calendar"></span>&nbsp;'+tag;
		}
		*/
		return tag;
	}

	return {
		updateSidebar: updateSidebar,
		clearSidebar: clearSidebar
	}

})();