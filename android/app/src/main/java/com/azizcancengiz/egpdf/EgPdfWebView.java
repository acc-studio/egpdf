package com.azizcancengiz.egpdf;

import android.content.Context;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;

import com.getcapacitor.CapacitorWebView;

/**
 * The app's WebView. Selecting text keeps the selection and its drag handles,
 * but the system's floating toolbar (Copy / Share / Select all) is started with
 * an empty menu, so Android doesn't draw it. It used to sit on top of egPDF's
 * own selection popup (Copy · Highlight · Edit text · Redact), making that
 * unreachable; the popup now carries Copy itself (mobile-ui.js).
 */
public class EgPdfWebView extends CapacitorWebView {

    public EgPdfWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback) {
        return super.startActionMode(new NoMenu(callback));
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        return super.startActionMode(new NoMenu(callback), type);
    }

    // Lets Chromium run its action mode (so the selection survives) but
    // empties the menu every time it is built or refreshed.
    private static final class NoMenu extends ActionMode.Callback2 {
        private final ActionMode.Callback inner;

        NoMenu(ActionMode.Callback inner) {
            this.inner = inner;
        }

        @Override
        public boolean onCreateActionMode(ActionMode mode, Menu menu) {
            boolean ok = inner.onCreateActionMode(mode, menu);
            menu.clear();
            return ok;
        }

        @Override
        public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
            boolean changed = inner.onPrepareActionMode(mode, menu);
            menu.clear();
            return changed;
        }

        @Override
        public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
            return inner.onActionItemClicked(mode, item);
        }

        @Override
        public void onDestroyActionMode(ActionMode mode) {
            inner.onDestroyActionMode(mode);
        }

        @Override
        public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
            if (inner instanceof ActionMode.Callback2) ((ActionMode.Callback2) inner).onGetContentRect(mode, view, outRect);
            else super.onGetContentRect(mode, view, outRect);
        }
    }
}
