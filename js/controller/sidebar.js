let $sidebar = (function() {

	/* This is currently a little broken */
	let SHOW_SIMILAR_ENTRIES = false; //TODO: turn this on when we have better notions of similarity

	function updateSidebar(items, item, subitem, mode_editing) {

		mode_editing = true;

		html = '';

		html += '<table id="tbl-advanced"><tr>';

		if (mode_editing) {
			html += '<td id="sidebar-editor-column" valign="top">';
			html += '<div style="color:white; font-weight:bold; padding-top:0px; margin-bottom:0px; font-size:large;">EDITOR</div>';

			html += '<hr>';

			let tags = [
				{
					tag: '@todo',
					action: 'action-toggle-todo',
					tooltip: 'Toggle @todo',
					display_name: 'todo',
					button_content: '<span class="glyphicon glyphicon-unchecked"></span>'
				},
				{
					tag: '@done',
					action: 'action-toggle-done',
					tooltip: 'Toggle @done',
					display_name: 'done',
					button_content: '<span class="glyphicon glyphicon-check"></span>'
				},
				{
					tag: '@list-bulleted',
					action: 'action-toggle-list-bulleted',
					tooltip: 'Toggle @list-bulleted',
					display_name: 'bulleted list',
					button_content: '<span class="glyphicon glyphicon-list"></span>'
				},
				{
					tag: '@list-numbered',
					action: 'action-toggle-list-numbered',
					tooltip: 'Toggle @list-numbered',
					display_name: 'numbered list',
					button_content: '<span class="glyphicon glyphicon-list-alt"></span>'
				},
				{
					tag: '@code',
					action: 'action-toggle-code',
					tooltip: 'Toggle @code',
					display_name: 'code',
					button_content: '<span class="glyphicon glyphicon-console"></span>'
				},
				{
					tag: '@bold',
					action: 'action-toggle-bold',
					tooltip: 'Toggle @bold',
					display_name: 'bold',
					button_content: '<span class="glyphicon glyphicon-bold"></span>'
				},
				{
					tag: '@italic',
					action: 'action-toggle-italic',
					tooltip: 'Toggle @italic',
					display_name: 'italic',
					button_content: '<span class="glyphicon glyphicon-italic"></span>'
				},
				{
					tag: '@h1',
					action: 'action-toggle-h1',
					tooltip: 'Toggle @h1',
					display_name: 'headline 1',
					button_content: 'h1'
				},
				{
					tag: '@h2',
					action: 'action-toggle-h2',
					tooltip: 'Toggle @h2',
					display_name: 'headline 2',
					button_content: 'h2'
				},
				{
					tag: '@h3',
					action: 'action-toggle-h3',
					tooltip: 'Toggle @h3',
					display_name: 'headline 3',
					button_content: 'h3'
				},
				{
					tag: '@h4',
					action: 'action-toggle-h4',
					tooltip: 'Toggle @h4',
					display_name: 'headline 4',
					button_content: 'h4'
				},
				{
					tag: '@embed',
					action: 'action-toggle-embed',
					tooltip: 'Toggle @embed',
					display_name: 'embed item',
					button_content: '<span class="glyphicon glyphicon-link"></span>'
				},
				{
					tag: '@copy',
					action: 'action-toggle-copy',
					tooltip: 'Toggle @copy',
					display_name: 'copy',
					button_content: '<span class="glyphicon glyphicon-copy"></span>'
				},
				{
					tag: '@paste',
					action: 'action-toggle-paste',
					tooltip: 'Toggle @paste',
					display_name: 'paste',
					button_content: '<span class="glyphicon glyphicon-paste"></span>'
				},
				{
					tag: '@date-headline',
					action: 'action-toggle-date-headline',
					tooltip: 'Toggle @date-headline',
					display_name: 'date headline',
					button_content: '<span class="glyphicon glyphicon-calendar"></span>'
				}
			];

			for (let t of tags) {
				let color = '';
				let extra_class = '';
				if (subitem != null && 
					(subitem._direct_tags.includes(t.tag) || 
					 subitem._implied_tags.includes(t.tag))) {
					color = 'white';
					extra_class = 'highlighted-format-option';
				}
				else {
					color = 'black';
				}
	            html += '<div style="margin:6px; font-weight:bold;">';
				html += '  <button type="button" title="'+t.tooltip+'" class="btn btn-default btn-sm '+t.action+' '+extra_class+'">';
	            html += '    '+t.button_content;
	            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">'+t.display_name+'</span>';
	            html += '</div>';
			}

            let date_value = '';
            if (item != null) {
            	date_value = formatDate(item);
            }

            html += '<div style="margin:6px;">';
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
					html += '<div style="padding-left:12px; color:white;">';
					if (all_shown.includes(tag) == false) {
						html += formatTag(tag);
						all_shown.push(tag);
						if (imps[tag] != undefined) {
							for (let imp of imps[tag]) {
								if (imp != tag) {
									html += '<div style="margin-left:35px; color:white;">';
									html += formatTag(imp);
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

			//TODO: this code is currently a bit broken
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

	function formatTag(tag) {
		tag = '<span class="badge badge-light meta-tag">'+tag+'</span>';
		return tag;
	}

	return {
		updateSidebar: updateSidebar,
		clearSidebar: clearSidebar
	}

})();