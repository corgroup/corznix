import { Dialog } from '../../../components/ui/Dialog.jsx';
import { Button } from '../../../components/ui/Button.jsx';

// Shown when a router navigation is blocked because sections still hold
// unsaved edits. `sections` is the human list of dirty section labels.
export function UnsavedChangesDialog({ open, sections, onKeepEditing, onDiscard }) {
  return (
    <Dialog
      open={open}
      onClose={onKeepEditing}
      title="You have unsaved changes"
      actions={
        <>
          <Button variant="ghost" onClick={onKeepEditing}>Keep editing</Button>
          <Button variant="danger-solid" onClick={onDiscard}>Discard changes</Button>
        </>
      }
    >
      <p>
        Unsaved edits in{' '}
        <strong>{sections.length ? sections.join(', ') : 'this product'}</strong>{' '}
        will be lost if you leave now.
      </p>
    </Dialog>
  );
}

export default UnsavedChangesDialog;
