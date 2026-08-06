import { defineComponent, h } from 'vue';

export default defineComponent({
  props: {
    title: { type: String, required: true },
    description: { type: String, required: true }
  },
  setup(props) {
    return () =>
      h('div', { class: 'v2-records-empty' }, [
        h('strong', props.title),
        h('span', props.description)
      ]);
  }
});
