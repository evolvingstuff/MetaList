'use strict';


class ToolBar extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }


    render() {
        let content = `<div class="tool-bar">`;
        content += `<button type="button" id="edit" class="activeBtn btnDeactivated">EDIT</button>`;
        content += `</div>`;
        this.innerHTML = content;
    }


    connectedCallback() {
        this.myId = this.getAttribute('id');


        // PubSub.subscribe('search.results', (msg, searchResults) => {
        //     this.render(searchResults['total_results']);
        // });
        this.render();
        this.querySelector('#edit').addEventListener('click', (event) => {
            if (state.modeEdit) {
                PubSub.publish('exit-edit-mode', {});
            }
            else {
                //TODO: should we require that one subitem be selected?
                if (state.selectedItemSubitemIds.size > 1) {
                    alert('You can only edit one item at a time. Please select only one item and try again.');
                    return;
                }
                PubSub.publish('enter-edit-mode', {});
            }
        });

        PubSub.subscribe('enter-edit-mode', (msg, searchFilter) => {
            state.modeEdit = true;
            this.querySelector('#edit').classList.remove('btnDeactivated');
            //TODO other modes should potentially be deactivated
        });

        PubSub.subscribe('exit-edit-mode', (msg, searchFilter) => {
            state.modeEdit = false;
            this.querySelector('#edit').classList.add('btnDeactivated');
        });
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

}

customElements.define('tool-bar', ToolBar);