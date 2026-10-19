package com.azizcancengiz.egpdf;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EgPdfPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
